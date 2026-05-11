/* ==========================================
   SISTEMA NERVOSO CENTRAL - BLACKROCK ADMIN
   ========================================== */
const URL_BASE = 'https://blackrock-gest-o.onrender.com';
const ADMIN_TOKEN = localStorage.getItem('br_admin_token');

// 1. BLINDAGEM: Verifica instantaneamente se o Diretor está logado
if (!ADMIN_TOKEN && !window.location.pathname.includes('admin_login.html')) {
    window.location.href = 'admin_login.html';
}

// 2. FUNÇÕES DE INTERFACE (Menu Lateral)
function toggleSidebar() { 
    document.getElementById('sidebar').classList.toggle('active'); 
    const overlay = document.getElementById('overlay');
    if(overlay) overlay.classList.toggle('active'); 
}

function logout() { 
    localStorage.removeItem('br_admin_token'); 
    localStorage.removeItem('br_admin_info'); 
    window.location.href = 'admin_login.html'; 
}

// 3. MOTOR DE ALERTAS GLOBAIS (Radar)
async function radarGlobalAlertas() {
    if (!ADMIN_TOKEN) return;
    
    try {
        const res = await fetch(`${URL_BASE}/api/admin/alertas-globais`, { 
            headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` } 
        });
        
        if (!res.ok) return;
        const dados = await res.json();
        
        atualizarBadge('badge-fin', dados.financeiro);
        atualizarBadge('badge-chat', dados.chat);
        atualizarBadge('badge-notif', dados.notificacoes);
        
    } catch(e) { 
        console.error("Falha silenciosa no radar global."); 
    }
}

function atualizarBadge(id, valor) {
    const badge = document.getElementById(id);
    if(badge) {
        if(valor > 0) {
            badge.innerText = valor;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    }
}

// 4. INICIALIZAÇÃO AUTOMÁTICA
// Garante que o radar roda a cada 15 segundos em todas as páginas onde este script for importado
if(ADMIN_TOKEN) {
    setTimeout(radarGlobalAlertas, 1000); // Roda 1 segundo após abrir a página
    setInterval(radarGlobalAlertas, 15000); // Fica varrendo o banco de dados a cada 15s
}