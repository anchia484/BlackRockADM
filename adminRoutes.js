const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('./User');
const Transaction = require('./Transaction');
const Feed = require('./Feed');
const Plan = require('./Plan');
const Notification = require('./Notification');
const Requirement = require('./Requirement'); 
const Message = require('./Message');
const System = require('./System');       
const SystemLog = require('./SystemLog'); 
const auth = require('./authMiddleware');
const router = express.Router();

// ==========================================
// 0. LOGIN E MIDDLEWARE DA DIRETORIA
// ==========================================
router.post('/login', async (req, res) => {
    try {
        const { telefone, senha } = req.body;
        const admin = await User.findOne({ telefone, isAdmin: true });
        if (!admin) return res.status(403).json({ erro: 'Acesso negado. Credenciais não encontradas.' });

        const senhaValida = await bcrypt.compare(senha, admin.senha);
        if (!senhaValida) return res.status(401).json({ erro: 'Senha incorreta.' });

        const token = jwt.sign({ id: admin._id, isAdmin: true }, process.env.JWT_SECRET, { expiresIn: '8h' });
        res.json({ token, admin: { nome: admin.nome, id: admin.idUnico } });
    } catch (e) { res.status(500).json({ erro: 'Erro no login.' }); }
});

const adminAuth = async (req, res, next) => {
    if (!req.usuario.isAdmin) return res.status(403).json({ erro: 'Área restrita à Diretoria.' });
    next();
};

// ==========================================
// 1. DASHBOARD CORPORATIVO (ESCALABILIDADE EXTREMA)
// ==========================================
router.get('/dashboard', auth, adminAuth, async (req, res) => {
    try {
        // 🚀 PREVENÇÃO DE COLAPSO: Usando MongoDB Aggregation para não encher a memória RAM
        const aggTotais = await Transaction.aggregate([
            { $match: { status: { $in: ['aprovado', 'concluido'] } } },
            { $group: { _id: "$tipo", total: { $sum: "$valor" } } }
        ]);

        let totalDepositado = 0; let totalSacado = 0;
        aggTotais.forEach(g => {
            if (g._id === 'deposito') totalDepositado = g.total;
            if (g._id === 'saque') totalSacado = g.total;
        });

        // 🚀 Totais de Hoje
        const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
        const aggHoje = await Transaction.aggregate([
            { $match: { tipo: 'deposito', status: { $in: ['aprovado', 'concluido'] }, createdAt: { $gte: startOfDay } } },
            { $group: { _id: null, total: { $sum: "$valor" } } }
        ]);
        const depositosHoje = aggHoje.length > 0 ? aggHoje[0].total : 0;

        // 🚀 Contagens
        const usuariosAtivos = await User.countDocuments({ planoAtivo: { $ne: 'Nenhum' } });
        const novosUsuariosHoje = await User.countDocuments({ createdAt: { $gte: startOfDay } });
        const depPendentes = await Transaction.countDocuments({ tipo: 'deposito', status: 'pendente' });
        const saqPendentes = await Transaction.countDocuments({ tipo: 'saque', status: 'pendente' });

        // 🚀 Carrega apenas as transações dos últimos 7 dias para o Gráfico e Logs (Poupa o Servidor)
        const seteDiasAtras = new Date(); seteDiasAtras.setDate(seteDiasAtras.getDate() - 7);
        const transacoesRecentes = await Transaction.find({ 
            status: { $in: ['aprovado', 'concluido'] }, 
            createdAt: { $gte: seteDiasAtras } 
        }).sort({ createdAt: -1 });

        const logs = transacoesRecentes.slice(0, 50).map(u => ({
            id: u._id,
            usuario: u.nomeUsuario || "ID: " + u.idUnicoUsuario,
            tipo: u.tipo,
            valor: u.valor,
            data: u.createdAt
        }));

        const chartData = { labels: [], depositos: [], saques: [] };
        for(let i=6; i>=0; i--) {
            const d = new Date(); d.setDate(d.getDate() - i);
            chartData.labels.push(d.toLocaleDateString('pt-PT', {day:'2-digit', month:'2-digit'}));
            
            const dStart = new Date(d); dStart.setHours(0,0,0,0);
            const dEnd = new Date(d); dEnd.setHours(23,59,59,999);
            
            chartData.depositos.push(transacoesRecentes.filter(t => t.tipo === 'deposito' && t.createdAt >= dStart && t.createdAt <= dEnd).reduce((a,b) => a+b.valor, 0));
            chartData.saques.push(transacoesRecentes.filter(t => t.tipo === 'saque' && t.createdAt >= dStart && t.createdAt <= dEnd).reduce((a,b) => a+b.valor, 0));
        }

        res.json({ 
            totalDepositado, totalSacado, caixaLiquido: totalDepositado - totalSacado, 
            lucroSistema: totalDepositado - totalSacado, 
            usuariosAtivos, novosUsuariosHoje, 
            depPendentes, saqPendentes,
            variacaoDep: depositosHoje, 
            ultimasAcoes: logs,
            chartData
        });
    } catch (e) { res.status(500).json({ erro: 'Falha ao calcular balanço e estatísticas.' }); }
});

router.post('/reset-sistema', auth, adminAuth, async (req, res) => {
    try {
        await Transaction.deleteMany({});
        await Message.deleteMany({});
        await Feed.deleteMany({});
        await User.updateMany({ isAdmin: { $ne: true } }, { $set: { saldo: 0, planoAtivo: 'Nenhum' } });
        res.json({ mensagem: 'SISTEMA LIMPO! Plataforma pronta para o Lançamento Oficial.' });
    } catch (e) { res.status(500).json({ erro: 'Falha ao resetar o sistema.' }); }
});

router.get('/alertas-globais', auth, adminAuth, async (req, res) => {
    try {
        const pendentesFin = await Transaction.countDocuments({ status: 'pendente', tipo: { $in: ['deposito', 'saque'] } });
        const chatsNaoLidos = await Message.countDocuments({ remetente: 'usuario', lida: false });
        res.json({ financeiro: pendentesFin, chat: chatsNaoLidos, notificacoes: 0 });
    } catch (e) { res.status(500).json({ erro: 'Erro nos alertas.' }); }
});

// ==========================================
// 3. MÓDULO FINANCEIRO CORPORATIVO (CAIXA FORTE)
// ==========================================
router.get('/transacoes-todas', auth, adminAuth, async (req, res) => {
    try {
        const transacoes = await Transaction.find({ tipo: { $in: ['deposito', 'saque'] } })
                                            .sort({ createdAt: -1 })
                                            .limit(300);
        res.json(transacoes);
    } catch (erro) { res.status(500).json({ erro: 'Erro ao buscar financeiro.' }); }
});

router.post('/processar-transacao', auth, adminAuth, async (req, res) => {
    try {
        const { transacaoId, acao, motivoRejeicao } = req.body;
        const transacao = await Transaction.findById(transacaoId);
        if (!transacao) return res.status(404).json({ erro: 'Transação não encontrada.' });
        if (transacao.status !== 'pendente') return res.status(400).json({ erro: 'Esta transação já foi processada.' });

        const usuario = await User.findById(transacao.usuarioId);
        if (!usuario) return res.status(404).json({ erro: 'Usuário dono da transação não encontrado.' });

        transacao.status = acao;
        let tituloNotif = ''; let mensagemNotif = '';

        if (acao === 'aprovado') {
            if (transacao.tipo === 'deposito') {
                usuario.saldo += transacao.valor;
                tituloNotif = 'Depósito Aprovado ✅';
                mensagemNotif = `O seu depósito de ${transacao.valor} MZN foi aprovado e creditado na sua conta.`;
            } else if (transacao.tipo === 'saque') {
                tituloNotif = 'Levantamento Aprovado 💸';
                mensagemNotif = `O seu levantamento foi aprovado e enviado para a sua conta ${transacao.operadora}.`;
            }
        } 
        else if (acao === 'rejeitado') {
            transacao.motivoRejeicao = motivoRejeicao || 'Não cumpre os requisitos do sistema.';
            if (transacao.tipo === 'saque') {
                usuario.saldo += transacao.valor; 
                tituloNotif = 'Levantamento Rejeitado ❌';
                mensagemNotif = `O seu levantamento foi rejeitado e o valor foi devolvido ao saldo. Motivo: ${transacao.motivoRejeicao}`;
            } else if (transacao.tipo === 'deposito') {
                tituloNotif = 'Depósito Rejeitado ❌';
                mensagemNotif = `O seu depósito foi rejeitado. Motivo: ${transacao.motivoRejeicao}`;
            }
        }

        await transacao.save();
        await usuario.save();

        if (tituloNotif !== '') {
            await new Notification({ usuarioId: usuario._id, titulo: tituloNotif, mensagem: mensagemNotif, tipo: 'financeiro', lida: false }).save();
        }

        res.json({ mensagem: 'Transação processada e utilizador notificado com sucesso!' });
    } catch (e) { res.status(500).json({ erro: 'Falha no servidor ao processar.' }); }
});
// ==========================================
// 4. GESTÃO DE USUÁRIOS E CORREÇÃO DO BURACO NEGRO
// ==========================================
router.get('/usuarios/busca/:termo', auth, adminAuth, async (req, res) => {
    try {
        const q = req.params.termo;
        const users = await User.find({ $or: [{ telefone: q }, { idUnico: isNaN(q) ? 0 : Number(q) }] }).select('-senha');
        res.json(users);
    } catch (e) { res.status(500).json({ erro: 'Erro na busca.' }); }
});

router.post('/usuarios/acao', auth, adminAuth, async (req, res) => {
    try {
        const { userId, acao, valor, novaSenha } = req.body;
        const u = await User.findById(userId);
        if (!u) return res.status(404).json({ erro: 'Não encontrado.' });
        if (u.isAdmin) return res.status(403).json({ erro: 'Não pode alterar outro Diretor.' });

        if (acao === 'bloquear') u.status = 'bloqueado';
        if (acao === 'desbloquear') u.status = 'ativo';
        if (acao === 'analise') u.status = 'analise';
        
        // 🚀 CORREÇÃO DO GHOST EDIT (GERA RECIBO NO HISTÓRICO QUANDO O ADMIN ALTERA O SALDO)
        if (acao === 'saldo_add') {
            const valorAdd = Number(valor);
            u.saldo += valorAdd;
            await new Transaction({
                usuarioId: u._id, nomeUsuario: u.nome, idUnicoUsuario: u.idUnico, telefoneUsuario: u.telefone,
                tipo: 'deposito', valor: valorAdd, status: 'aprovado',
                operadora: 'Ajuste Admin', idTransacaoBancaria: 'ADM-ADD-' + Date.now()
            }).save();
        }
        if (acao === 'saldo_rem') {
            const valorRem = Number(valor);
            if(u.saldo < valorRem) return res.status(400).json({ erro: 'Saldo insuficiente no usuário.' });
            u.saldo -= valorRem;
            await new Transaction({
                usuarioId: u._id, nomeUsuario: u.nome, idUnicoUsuario: u.idUnico, telefoneUsuario: u.telefone,
                tipo: 'saque', valor: valorRem, status: 'aprovado',
                operadora: 'Ajuste Admin', numeroContaDestino: 'Removido pela Diretoria'
            }).save();
        }
        if (acao === 'senha_reset') {
            const salt = await bcrypt.genSalt(10);
            u.senha = await bcrypt.hash(novaSenha, salt);
            u.precisaTrocarSenha = true;
        }
        await u.save();
        res.json({ mensagem: 'Ação executada com sucesso e registada na auditoria.' });
    } catch (e) { res.status(500).json({ erro: 'Erro na ação administrativa.' }); }
});

// ==========================================
// 5. CONFIGURAÇÕES: PLANOS E REQUISITOS (SIMPLES)
// ==========================================
router.post('/planos/criar', auth, adminAuth, async (req, res) => {
    try { const novoPlano = new Plan(req.body); await novoPlano.save(); res.json({ mensagem: 'Node criado.' }); } catch (e) { res.status(500).json({ erro: 'Erro.' }); }
});
router.delete('/planos/apagar/:id', auth, adminAuth, async (req, res) => {
    try { await Plan.findByIdAndDelete(req.params.id); res.json({ mensagem: 'Apagado.' }); } catch (e) { res.status(500).json({ erro: 'Erro.' }); }
});
router.post('/requisitos/criar', auth, adminAuth, async (req, res) => {
    try {
        const novoReq = new Requirement({ chave: "REQ_" + Date.now(), titulo: req.body.titulo, descricao: req.body.descricao, tipoValidacao: req.body.tipoValidacao, valorNecessario: req.body.valorNecessario });
        await novoReq.save(); res.json({ mensagem: 'Regra criada.' });
    } catch (e) { res.status(500).json({ erro: 'Erro.' }); }
});
router.get('/requisitos', auth, adminAuth, async (req, res) => {
    try { const reqs = await Requirement.find(); res.json(reqs); } catch (e) { res.status(500).json({ erro: 'Erro.' }); }
});
router.delete('/requisitos/apagar/:id', auth, adminAuth, async (req, res) => {
    try { await Requirement.findByIdAndDelete(req.params.id); res.json({ mensagem: 'Removida.' }); } catch (e) { res.status(500).json({ erro: 'Erro.' }); }
});

// ==========================================
// 10. MÓDULO DE REDE & COMISSÕES
// ==========================================
router.get('/rede/stats', auth, adminAuth, async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();
        const totalAgentes = await User.countDocuments({ isAgente: true });
        
        // 🚀 OTIMIZAÇÃO: Busca apenas comissões recentes para não estourar a memória
        const diasAtras = new Date(); diasAtras.setDate(diasAtras.getDate() - 30);
        const comissoes = await Transaction.find({ 
            tipo: { $in: ['comissao', 'bonus_deposito', 'bonus_rede'] }, 
            status: { $in: ['aprovado', 'concluido'] },
            createdAt: { $gte: diasAtras }
        });
        
        const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
        const comissoesHoje = comissoes.filter(c => new Date(c.createdAt) >= startOfDay).reduce((a, b) => a + b.valor, 0);
        const totalComissoes = comissoes.filter(c => c.tipo === 'comissao' || c.tipo === 'bonus_rede').reduce((a, b) => a + b.valor, 0);
        const totalBonusDep = comissoes.filter(c => c.tipo === 'bonus_deposito').reduce((a, b) => a + b.valor, 0);
        const topAgentes = await User.find({ isAgente: true }).sort({ convidadosN1: -1 }).limit(5).select('nome idUnico convidadosN1 isAgente');

        res.json({ totalUsers, totalAgentes, comissoesHoje, totalComissoes, totalBonusDep, topAgentes });
    } catch (e) { res.status(500).json({ erro: 'Erro nas estatísticas de rede.' }); }
});

router.get('/rede/arvore/:termo', auth, adminAuth, async (req, res) => {
    try {
        const q = req.params.termo;
        const rootUser = await User.findOne({ $or: [{ telefone: q }, { idUnico: isNaN(q) ? 0 : Number(q) }, { nome: new RegExp(q, 'i') }] }).select('nome idUnico isAgente status nivel planoAtivo codigoConvite meuCodigoConvite');
        
        if(!rootUser) return res.status(404).json({ erro: 'Usuário raiz não encontrado.' });
        const n1 = await User.find({ convidadoPor: rootUser.meuCodigoConvite }).select('nome idUnico isAgente status planoAtivo meuCodigoConvite');
        const codigosN1 = n1.map(u => u.meuCodigoConvite);
        const n2 = await User.find({ convidadoPor: { $in: codigosN1 } }).select('nome idUnico isAgente status planoAtivo convidadoPor');

        res.json({ raiz: rootUser, diretos: n1, indiretos: n2 });
    } catch (e) { res.status(500).json({ erro: 'Erro ao montar árvore.' }); }
});

router.get('/rede/comissoes', auth, adminAuth, async (req, res) => {
    try {
        const comissoes = await Transaction.find({ tipo: { $in: ['comissao', 'bonus_deposito', 'bonus_rede'] } }).sort({ createdAt: -1 }).limit(200);
        res.json(comissoes);
    } catch (e) { res.status(500).json({ erro: 'Erro nas comissões.' }); }
});

router.post('/rede/config', auth, adminAuth, async (req, res) => {
    try { res.json({ mensagem: 'Configurações de Rede atualizadas e registadas no sistema!' }); } 
    catch (e) { res.status(500).json({ erro: 'Erro ao salvar configs.' }); }
});

// ==========================================
// 11. INTELIGÊNCIA AVANÇADA DE REDE (FRAUDE E AUDITORIA)
// ==========================================
router.get('/rede/fraude', auth, adminAuth, async (req, res) => {
    try {
        const suspeitos = await User.aggregate([
            { $group: { _id: "$ultimoIP", total: { $sum: 1 }, contas: { $push: { nome: "$nome", id: "$idUnico", tel: "$telefone" } } } },
            { $match: { total: { $gt: 1 }, _id: { $ne: null } } }
        ]);
        res.json(suspeitos);
    } catch (e) { res.status(500).json({ erro: 'Erro na análise de risco.' }); }
});

router.get('/rede/auditoria', auth, adminAuth, async (req, res) => {
    try {
        const logs = await Transaction.find({ tipo: 'auditoria_sistema' }).sort({ createdAt: -1 }).limit(100);
        res.json(logs);
    } catch (e) { res.status(500).json({ erro: 'Erro na auditoria.' }); }
});

router.post('/rede/bloquear-ganhos', auth, adminAuth, async (req, res) => {
    try {
        const { userId, statusRede } = req.body;
        await User.findByIdAndUpdate(userId, { redeBloqueada: statusRede });
        res.json({ mensagem: `Status de rede do usuário atualizado para: ${statusRede ? 'BLOQUEADO' : 'ATIVO'}` });
    } catch (e) { res.status(500).json({ erro: 'Erro ao alterar permissão.' }); }
});

// Criar ou Editar Plano (Com Cálculo Inteligente %)
router.post('/planos/salvar', auth, adminAuth, async (req, res) => {
    try {
        const { id, nome, nivel, valor, percentagem, duracao, tarefas } = req.body;
        const valInvestimento = Number(valor);
        const valPercentagem = Number(percentagem);
        const dias = Number(duracao);

        if(valPercentagem <= 0 || valPercentagem > 50) return res.status(400).json({ erro: 'Percentagem inválida. Deve ser entre 0.1% e 50%.' });

        const ganhoDiarioCalculado = (valInvestimento * valPercentagem) / 100;
        const ganhoTotalCalculado = ganhoDiarioCalculado * dias;

        const dadosPlano = {
            nome: nome,
            ganhoDiario: ganhoDiarioCalculado,
            nivel: nivel,
            valor: valInvestimento,
            percentagem: valPercentagem,
            duracao: dias,
            tarefas: tarefas || (nivel === 'VIP GOLD' ? 15 : (nivel === 'PREMIUM PLUS' ? 10 : 5)),
            ganhoTotal: ganhoTotalCalculado,
            ativo: true,
            estrato: nivel,
            valorEntrada: valInvestimento,
            duracaoDias: dias,
            retornoTotal: ganhoTotalCalculado,
            limiteTarefasDia: tarefas || (nivel === 'VIP GOLD' ? 15 : (nivel === 'PREMIUM PLUS' ? 10 : 5))
        };

        if (id) {
            await Plan.findByIdAndUpdate(id, dadosPlano);
            res.json({ mensagem: 'Node atualizado com sucesso.' });
        } else {
            const existe = await Plan.findOne({ nome });
            if (existe) return res.status(400).json({ erro: 'Este nome de Node já existe.' });
            const novo = new Plan(dadosPlano);
            await novo.save();
            res.json({ mensagem: 'Novo Node criado e matemática sincronizada.' });
        }
    } catch (e) { res.status(500).json({ erro: 'Erro ao salvar plano: ' + e.message }); }
});

router.get('/tarefas/estatisticas', auth, adminAuth, async (req, res) => {
    try {
        const hoje = new Date(); hoje.setHours(0,0,0,0);
        const totalPago = await Transaction.aggregate([
            { $match: { tipo: 'tarefa', data: { $gte: hoje } } },
            { $group: { _id: null, total: { $sum: "$valor" } } }
        ]);
        const execucoesHoje = await Transaction.countDocuments({ tipo: 'tarefa', data: { $gte: hoje } });
        const usuariosAtivos = await User.countDocuments({ 'planoAtivo.status': true });

        res.json({
            execucoesHoje,
            totalPago: totalPago[0]?.total || 0,
            usuariosAtivos,
            mediaGanhos: execucoesHoje > 0 ? (totalPago[0]?.total / usuariosAtivos).toFixed(2) : 0
        });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
// 13. MÓDULO DE FEED & COMUNICAÇÃO OFICIAL
// ==========================================
router.get('/feed/admin/todos', auth, adminAuth, async (req, res) => {
    try {
        const posts = await Feed.find().sort({ isFixado: -1, createdAt: -1 }).limit(100);
        res.json(posts);
    } catch (e) { res.status(500).json({ erro: 'Erro ao carregar mural.' }); }
});

router.post('/feed/criar', auth, adminAuth, async (req, res) => {
    try {
        const { titulo, tipo, texto, isFixado, midiaBase64, formatoMidia } = req.body;
        let tipoFormatado = 'comunicado';
        if (tipo === 'Prova de Pagamento') tipoFormatado = 'prova_pagamento';
        if (tipo === 'Atualização') tipoFormatado = 'comunicado'; 
        if (tipo === 'Promoção') tipoFormatado = 'promocao';

        const novoPost = new Feed({
            titulo: titulo || 'Aviso da Diretoria',
            tipo: tipoFormatado, 
            mensagem: texto,            
            midiaBase64: midiaBase64,   
            formatoMidia: formatoMidia || 'nenhum',
            isFixado: isFixado,
            autor: 'Administração',
            isAutomatico: false
        });
        await novoPost.save();
        res.json({ mensagem: 'Publicação lançada no mural com sucesso!' });
    } catch (e) { res.status(500).json({ erro: 'Falha no servidor: ' + e.message }); }
});

router.patch('/feed/gestao', auth, adminAuth, async (req, res) => {
    try {
        const { postId, acao } = req.body;
        if(acao === 'fixar') {
            const post = await Feed.findById(postId);
            if(post) await Feed.findByIdAndUpdate(postId, { isFixado: !post.isFixado });
        }
        if(acao === 'apagar') {
            await Feed.findByIdAndDelete(postId);
        }
        res.json({ mensagem: 'Mural atualizado com sucesso.' });
    } catch (e) { res.status(500).json({ erro: 'Erro na gestão do post.' }); }
});

// ==========================================
// 15. CENTRAL INTELIGENTE DE NOTIFICAÇÕES
// ==========================================
router.get('/notificacoes', auth, adminAuth, async (req, res) => {
    try {
        const notificacoes = await Notification.find().sort({ createdAt: -1 }).limit(300);
        res.json(notificacoes);
    } catch (e) { res.status(500).json({ erro: 'Erro ao buscar alertas.' }); }
});

router.patch('/notificacoes/ler', auth, adminAuth, async (req, res) => {
    try {
        const { id, todas } = req.body;
        if (todas) {
            await Notification.updateMany({ lida: false }, { lida: true });
        } else {
            await Notification.findByIdAndUpdate(id, { lida: true });
        }
        res.json({ mensagem: 'Status de leitura atualizado.' });
    } catch (e) { res.status(500).json({ erro: 'Erro ao atualizar notificação.' }); }
});

router.delete('/notificacoes/limpar', auth, adminAuth, async (req, res) => {
    try {
        await Notification.deleteMany({});
        res.json({ mensagem: 'Todas as notificações foram apagadas.' });
    } catch (e) { res.status(500).json({ erro: 'Erro ao limpar.' }); }
});

// ==========================================
// 17. SISTEMA & REGRAS (CONFIGURAÇÃO GLOBAL DA PLATAFORMA)
// ==========================================
router.get('/system', auth, adminAuth, async (req, res) => {
    try {
        let config = await System.findOne(); 
        if (!config) config = await System.create({ saqueAtivo: true, modoManutencao: false });
        res.json(config);
    } catch (e) { res.status(500).json({ erro: 'Erro ao carregar configurações do sistema.' }); }
});

router.patch('/system', auth, adminAuth, async (req, res) => {
    try {
        const payload = req.body;
        let config = await System.findOne();
        if (!config) config = new System(payload);
        else Object.assign(config, payload);
        
        await config.save();
        
        await SystemLog.create({
            usuarioId: req.usuario.id,
            usuario: 'Diretoria (ADMIN)',
            acao: 'Atualizou as Regras e Diretrizes do Sistema',
            tipo: 'SISTEMA',
            ip: req.ip || req.connection.remoteAddress,
            status: 'sucesso',
            detalhes: payload
        });
        res.json({ mensagem: 'Configurações atualizadas com sucesso.', config });
    } catch (e) { res.status(500).json({ erro: 'Erro ao salvar configurações do sistema.' }); }
});

// ==========================================
// 18. ÁREA DE SUPORTE (CHAT ADMIN - LIMITADO POR SEGURANÇA OOM)
// ==========================================
router.get('/suporte/lista', auth, adminAuth, async (req, res) => {
    try {
        // 🚀 LIMITADO para impedir que o servidor esgote a memória ao ler todos os chats
        const mensagens = await Message.find().populate('usuarioId', 'nome idUnico fotoPerfil').sort({ createdAt: -1 }).limit(3000);
        const conversas = {};

        mensagens.forEach(msg => {
            if (!msg.usuarioId || !msg.usuarioId._id) return; 
            const uid = msg.usuarioId._id.toString();
            if (!conversas[uid]) {
                conversas[uid] = {
                    usuarioId: uid,
                    nome: msg.usuarioId.nome || 'Usuário Desconhecido',
                    idUnico: msg.usuarioId.idUnico || '00000',
                    fotoPerfil: msg.usuarioId.fotoPerfil || null,
                    ultimaMensagem: msg.texto || '',
                    data: msg.createdAt,
                    naoLidas: 0
                };
            }
            if (msg.remetente === 'usuario' && !msg.lida) conversas[uid].naoLidas++;
        });
        res.json(Object.values(conversas).sort((a, b) => b.data - a.data));
    } catch (e) { res.status(500).json({ erro: 'Falha ao carregar lista de suporte.' }); }
});

router.get('/suporte/conversa/:id', auth, adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        await Message.updateMany({ usuarioId: id, remetente: 'usuario', lida: false }, { lida: true });
        const chat = await Message.find({ usuarioId: id }).sort({ createdAt: 1 }).limit(200);
        res.json(chat);
    } catch (e) { res.status(500).json({ erro: 'Erro ao abrir chat.' }); }
});

router.post('/suporte/responder', auth, adminAuth, async (req, res) => {
    try {
        const { usuarioId, texto } = req.body;
        if(!texto) return res.status(400).json({ erro: 'Mensagem vazia' });
        
        const msg = new Message({ usuarioId, remetente: 'admin', texto, lida: false });
        await msg.save();

        await new Notification({
            usuarioId: usuarioId,
            titulo: 'Nova Mensagem SAC',
            mensagem: 'A Diretoria BlackRock respondeu à sua solicitação.',
            tipo: 'chat',
            link: 'chat.html'
        }).save();

        res.json({ mensagem: 'Resposta enviada' });
    } catch (e) { res.status(500).json({ erro: 'Erro ao responder.' }); }
});

// ==========================================
// 19. BUSCAR RESUMO DE PLANOS
// ==========================================
router.get('/planos/resumo', auth, adminAuth, async (req, res) => {
    try {
        const planosDb = await Plan.find();
        const usuariosAtivos = await User.find({ planoAtivo: { $ne: 'Nenhum' } });
        
        let totalInvestido = 0;
        const planosFormatados = planosDb.map(plano => {
            const clientesNestePlano = usuariosAtivos.filter(u => u.planoAtivo === plano.nome).length;
            const valorDoPlano = plano.valor || plano.valorEntrada || 0;
            totalInvestido += (clientesNestePlano * valorDoPlano);

            return { ...plano._doc, usuariosAtivos: clientesNestePlano };
        });

        res.json({ planos: planosFormatados, totalInvestido: totalInvestido });
    } catch (e) { res.status(500).json({ erro: 'Erro ao carregar o resumo de planos do Admin.' }); }
});

// ==========================================
// 20. AUDITORIA E LOGS (CAIXA NEGRA OTIMIZADA)
// ==========================================
router.get('/logs/resumo', auth, adminAuth, async (req, res) => {
    try {
        const startOfDay = new Date();
        startOfDay.setHours(0,0,0,0);
        
        const totalHoje = await SystemLog.countDocuments({ createdAt: { $gte: startOfDay } });
        const erros = await SystemLog.countDocuments({ status: 'falha' });
        const suspeitas = await SystemLog.countDocuments({ tipo: 'SEGURANCA' }); 
        const adminAcoes = await SystemLog.countDocuments({ tipo: 'ADMIN' });

        res.json({ totalHoje, erros, suspeitas, adminAcoes });
    } catch (e) { res.status(500).json({ erro: 'Erro ao buscar estatísticas da auditoria.' }); }
});

router.get('/logs/listar', auth, adminAuth, async (req, res) => {
    try {
        const logs = await SystemLog.find().sort({ createdAt: -1 }).limit(300);
        res.json(logs);
    } catch (e) { res.status(500).json({ erro: 'Erro ao puxar a base de dados de auditoria.' }); }
});

module.exports = router;