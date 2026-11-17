/**
 * server.cjs - VERSÃO BETTER-SQLITE3
 * Este arquivo contém toda a lógica do Backend (API) e acesso a Banco de Dados do sistema Termo EPI.
 */
const express = require("express"); // Framework web robusto para criação de endpoints da API
const cors = require("cors"); // Permite requisições de outras origens (Cross-Origin Resource Sharing)
const Database = require("better-sqlite3"); // Driver do banco SQLite síncrono e ultra rápido
const bodyParser = require("body-parser"); // Middleware para extrair payload JSON do corpo da requisição HTTP
const bcrypt = require("bcryptjs"); // Biblioteca criptográfica para fazer hash e validação de senhas de forma segura
const fs = require("fs");
const path = require("path");

const app = express();
// Configuração da porta onde o backend ficará escutando, usamos process.env para produção ou 3001 como failover para dev env
const PORT = process.env.PORT || 3001;

// Middlewares Globais da aplicação
app.use(cors());
// Limite extendido para 50mb pois salvaremos as strings codificadas em base64 da Assinatura e dos Formulários!
app.use(bodyParser.json({ limit: "50mb" }));

/**
 * Função utilitária para capturar e normalizar o IP do cliente.
 * Importante para garantir a segurança no LOG de requisições de "aceite" do termo.
 */
const getIp = req => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  return ip ? ip.replace(/^.*:/, "") : "127.0.0.1";
};

/**
 * ==========================================
 * CONEXÃO COM O BANCO DE DADOS (SQLITE)
 * ==========================================
 * O arquivo "sistema_v2.db" é instanciado na mesma pasta do servidor onde rodar.
 */
const db = new Database("./sistema_v2.db");
console.log("Conectado ao banco de dados (sistema_v2.db).");
console.log(`Servidor HTTP estará escutando na porta ${PORT}`);

// Migration: Verifica se já existe coluna "suspended" (para inativar usuários em um banco existente sem apagar ele).
try {
  const cols = db.prepare("PRAGMA table_info(users)").all();
  const hasSuspended = cols.some(c => c && c.name === "suspended");
  if (!hasSuspended) {
    console.log("Migrando: adicionando coluna suspended na tabela users");
    db.prepare(
      "ALTER TABLE users ADD COLUMN suspended INTEGER DEFAULT 0"
    ).run();
  }
} catch (err) {
  // Ignora erros de inicializações limpas quando uma migration roda em vazio.
}

/** 
 * Criação da função de hash injetando um padrão fixo de salt de 10 passos pelo bcrypt.
 */
const hashPassword = password => bcrypt.hashSync(password, 10);

const getPeriodStart = period => {
  const now = new Date();
  const start = new Date(now);

  switch (period) {
    case "today":
      start.setHours(0, 0, 0, 0);
      return start.toISOString();
    case "7d":
      start.setDate(start.getDate() - 7);
      return start.toISOString();
    case "30d":
      start.setDate(start.getDate() - 30);
      return start.toISOString();
    default:
      return null;
  }
};

/**
 * ==========================================
 * INICIALIZADOR DE ESTRUTURA E SEEDS (USUÁRIOS PADRÃO)
 * ==========================================
 * Esta função cria as tabelas caso estejamos executando o programa em uma máquina do zero.
 */
const initDb = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT, username TEXT UNIQUE, password TEXT, role TEXT, recovery_key TEXT, signature TEXT, suspended INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS event_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, full_name TEXT, action TEXT, term_version TEXT, timestamp DATETIME, ip_address TEXT);
    CREATE TABLE IF NOT EXISTS epi_forms (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, title TEXT, form_data TEXT, epi_items TEXT, created_at DATETIME);
  `);

  // Verifica se o admin existe, se não, cria os usuários padrão
  const adminExists = db
    .prepare("SELECT * FROM users WHERE username = 'admin'")
    .get();

  if (!adminExists) {
    console.log("Criando usuários padrão...");
    const insert = db.prepare(
      "INSERT INTO users (full_name, username, password, role, recovery_key, signature) VALUES (?, ?, ?, ?, ?, ?)"
    );
    insert.run(
      "ADMINISTRADOR DO SISTEMA",
      "admin",
      hashPassword("admin"),
      "admin",
      "admin",
      null
    );
    insert.run(
      "USUÁRIO PADRÃO",
      "user",
      hashPassword("123456"),
      "user",
      "123456",
      null
    );
    insert.run(
      "RECURSOS HUMANOS",
      "rh",
      hashPassword("M@Reunidos"),
      "rh",
      "rh123",
      null
    );
  }
};

initDb();

/**
 * ==========================================
 * MÓDULO DE ROTAS (CONTROLLERS)
 * ==========================================
 * Cada req/res engloba o que o Frontend precisa ler ou atualizar via FETCH no banco de dados.
 */

/**
 * [POST] /register -- Rota para criar (CADASTRAR) um novo usuário comum
 */
app.post("/register", (req, res) => {
  try {
    const { fullName, username, password, recoveryKey, signature } = req.body;
    // Checa se o usuário desejado já existe na base para não gerar duplicação
    const user = db
      .prepare("SELECT * FROM users WHERE username = ?")
      .get(username);
    if (user) return res.status(400).json({ error: "Usuário já existe!" });

    const hashedPassword = hashPassword(password);
    db.prepare(
      "INSERT INTO users (full_name, username, password, role, recovery_key, signature) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      fullName,
      username,
      hashedPassword,
      "user",
      recoveryKey,
      signature || null
    );

    const now = new Date().toISOString();
    const userIp = getIp(req);
    db.prepare(
      "INSERT INTO event_logs (username, full_name, action, term_version, timestamp, ip_address) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(username, fullName, "Cadastro de Novo Usuário", "-", now, userIp);
    res.json({ message: "Sucesso" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * [POST] /login -- Rota de autenticação de usuários
 * Onde verificamos credenciais em texto plano cruzados com hash do banco para garantir integridade
 */
app.post("/login", (req, res) => {
  try {
    const { username, password } = req.body;
    const row = db
      .prepare("SELECT * FROM users WHERE username = ?")
      .get(username);

    // Proteção direta caso o login não seja válido na hora
    if (!row) return res.status(401).json({ error: "Usuário não encontrado" });

    // Autenticador criptográfico nativo do Bcrypt
    const passwordIsValid = bcrypt.compareSync(password, row.password);
    
    // Tratamos uma fallback para quando criamos usuários teste via Admin usando password em texto puro sem hash.
    if (!passwordIsValid && row.password !== password) {
      return res.status(401).json({ error: "Senha incorreta" });
    }

    const now = new Date().toISOString();
    const userIp = getIp(req);
    db.prepare(
      "INSERT INTO event_logs (username, full_name, action, term_version, timestamp, ip_address) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(row.username, row.full_name, "Login no Sistema", "-", now, userIp);

    res.json({
      user: {
        id: row.id,
        username: row.username,
        full_name: row.full_name,
        role: row.role,
        signature: row.signature,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * [POST] /reset-password -- Rota de Esqueci a Senha
 * Usamos uma palavra-chave para restaurar o acesso para caso RH ou User esqueça a credencial
 */
app.post("/reset-password", (req, res) => {
  try {
    const { username, recoveryKey, newPassword } = req.body;
    const row = db
      .prepare("SELECT * FROM users WHERE username = ?")
      .get(username);
    if (!row) return res.status(404).json({ error: "Usuário não encontrado." });
    
    // Validando segurança de Reset contra bots
    if (
      row.recovery_key &&
      row.recovery_key.toLowerCase() !== recoveryKey.toLowerCase()
    )
      return res.status(401).json({ error: "Palavra-chave incorreta." });

    const hashedPassword = hashPassword(newPassword);
    db.prepare("UPDATE users SET password = ? WHERE id = ?").run(
      hashedPassword,
      row.id
    );
    res.json({ message: "Senha alterada" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * [PUT] /admin/users/:id -- Atualiza informações do usuário vindo exclusivamente da Tabela no Painel Admin
 */
app.put("/admin/users/:id", (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, username, password, role, signature, adminUser } =
      req.body;
      
    // Se quem faz a alteração inseriu nova senha, passamos a criptografia nela...
    if (password && password.trim() !== "") {
      db.prepare(
        "UPDATE users SET full_name = ?, username = ?, role = ?, password = ?, signature = ? WHERE id = ?"
      ).run(
        full_name,
        username,
        role,
        hashPassword(password),
        signature || null,
        id
      );
    // Mas se foi vazia, significa que atualizamos mantendo a senha existente intata.
    } else {
      db.prepare(
        "UPDATE users SET full_name = ?, username = ?, role = ?, signature = ? WHERE id = ?"
      ).run(full_name, username, role, signature || null, id);
    }
    const now = new Date().toISOString();
    const userIp = getIp(req);
    db.prepare(
      "INSERT INTO event_logs (username, full_name, action, term_version, timestamp, ip_address) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      adminUser,
      "ADMIN",
      `Alterou dados de: ${username}`,
      "-",
      now,
      userIp
    );
    res.json({ message: "Atualizado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * [POST] /log-event -- Rota de Logging Geral. 
 * Responsável por todo o balanço de Segurança Auditada (ações dos RH, Admins, users imprimindo PDF)
 */
app.post("/log-event", (req, res) => {
  try {
    const { username, fullName, action, termVersion } = req.body;
    const now = new Date().toISOString();
    const userIp = getIp(req);
    db.prepare(
      "INSERT INTO event_logs (username, full_name, action, term_version, timestamp, ip_address) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      username,
      fullName || username, // Fallback p/ caso não tenhamos full_name
      action,
      termVersion || "-",
      now,
      userIp
    );
    res.json({ status: "logged" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * [GET] /admin/logs -- Retorna registros da base do Histórico (logs) para o ViewAdmin do sistema.
 */
app.get("/admin/logs", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM event_logs ORDER BY id DESC").all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * [GET] /admin/users -- Extrai todos os usuários, exceto senhas brutas. É renderizado na TableUsers (React).
 */
app.get("/admin/users", (req, res) => {
  try {
    const rows = db
      .prepare(
        "SELECT id, full_name, username, role, signature, suspended FROM users ORDER BY full_name ASC"
      )
      .all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * [DELETE] /admin/users/:id -- Deletar permanentemente um usuário selecionado pelo painel
 * Mantemos o registro da açao deste Delete gerida pela role MASTER no banco.
 */
app.delete("/admin/users/:id", (req, res) => {
  try {
    const { id } = req.params;
    const { adminUser } = req.body || {};
    const user = db
      .prepare("SELECT username, full_name FROM users WHERE id = ?")
      .get(id);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
    const now = new Date().toISOString();
    const userIp = getIp(req);
    db.prepare(
      "INSERT INTO event_logs (username, full_name, action, term_version, timestamp, ip_address) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      adminUser || "admin",
      "ADMIN",
      `Removeu usuário: ${user.username}`,
      "-",
      now,
      userIp
    );
    res.json({ message: "Deletado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * [PUT] /admin/users/:id/suspend -- Opcão de Inativar Sem Deletar Permanentemente
 * É muito útil em plataformas RH onde pessoas param de se reciclar, mas você não quer jogar os Logs gerados no lixo.
 */
app.put("/admin/users/:id/suspend", (req, res) => {
  try {
    const { id } = req.params;
    const { suspended, adminUser } = req.body;
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Usuário não encontrado" });
    const s = suspended ? 1 : 0;
    db.prepare("UPDATE users SET suspended = ? WHERE id = ?").run(s, id);
    const now = new Date().toISOString();
    const userIp = getIp(req);
    db.prepare(
      "INSERT INTO event_logs (username, full_name, action, term_version, timestamp, ip_address) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      adminUser || "admin",
      "ADMIN",
      `${s ? "Suspendeu" : "Reativou"} usuário: ${row.username}`,
      "-",
      now,
      userIp
    );
    res.json({ message: "OK" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * [GET] /admin/stats -- Gerencia os relatórios bonitos do Home Dashboard. Contabilidades e agrupamentos.
 */
app.get("/admin/stats", (req, res) => {
  try {
    const period = req.query.period || "7d";
    const periodStart = getPeriodStart(period);
    const logsWhere = periodStart ? "WHERE timestamp >= ?" : "";
    const logsParams = periodStart ? [periodStart] : [];
    const stats = {};

    stats.totalUsers = db
      .prepare("SELECT COUNT(*) as count FROM users")
      .get().count;

    stats.totalPDFs = db
      .prepare(
        `SELECT COUNT(*) as count FROM event_logs ${logsWhere ? `${logsWhere} AND` : "WHERE"} action LIKE '%PDF%'`
      )
      .get(...logsParams).count;

    stats.loginsToday = db
      .prepare(
        `SELECT COUNT(*) as count FROM event_logs ${logsWhere ? `${logsWhere} AND` : "WHERE"} action LIKE '%Login%'`
      )
      .get(...logsParams).count;

    stats.topUsers = db
      .prepare(
        `SELECT full_name, COUNT(*) as count
         FROM event_logs
         ${logsWhere ? `${logsWhere} AND` : "WHERE"} action LIKE '%PDF%'
         GROUP BY full_name
         ORDER BY count DESC
         LIMIT 5`
      )
      .all(...logsParams);

    const actionRows = db
      .prepare(
        `SELECT action, COUNT(*) as count
         FROM event_logs
         ${logsWhere}
         GROUP BY action`
      )
      .all(...logsParams);

    stats.actionsDistribution = actionRows.map(r => ({
      name: r.action.includes("PDF")
        ? "Gerou PDF"
        : r.action.includes("Login")
          ? "Login"
          : r.action.includes("Logout")
            ? "Logout"
            : "Outros",
      value: r.count,
    }));

    stats.recentActivities = db
      .prepare(
        `SELECT id, username, full_name, action, term_version, timestamp, ip_address
         FROM event_logs
         ${logsWhere}
         ORDER BY id DESC
         LIMIT 8`
      )
      .all(...logsParams);

    stats.period = period;

    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ==========================================
 * ROTAS DE RESGATE DOS FORMULÁRIOS SALVOS (RASCUNHOS EPI)
 * ==========================================
 * O Frontend do React mantem todo estado, porém a base salva a array JSON completa como TEXT no SQLite.
 */

/** [POST] /forms -- Salvar ou criar um novo formulário */
app.post("/forms", (req, res) => {
  try {
    const { userId, title, formData, epiItems } = req.body;
    const now = new Date().toISOString();
    const info = db
      .prepare(
        "INSERT INTO epi_forms (user_id, title, form_data, epi_items, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(
        userId,
        title,
        JSON.stringify(formData), // Stringify massivo JSON => TEXT
        JSON.stringify(epiItems),
        now
      );
    res.json({ message: "Salvo", id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
/** [PUT] /forms/:id -- Atualiza Formulário Existente já que passamos um ID */
app.put("/forms/:id", (req, res) => {
  try {
    const { id } = req.params;
    const { title, formData, epiItems } = req.body;
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE epi_forms SET title = ?, form_data = ?, epi_items = ?, created_at = ? WHERE id = ?"
    ).run(title, JSON.stringify(formData), JSON.stringify(epiItems), now, id);
    res.json({ message: "Atualizado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** [GET] /forms/:userId -- Traz somente os formulários preenchidos correspondentes ao ID do usuário/funcionário logado */
app.get("/forms/:userId", (req, res) => {
  try {
    const { userId } = req.params;
    const rows = db
      .prepare(
        "SELECT * FROM epi_forms WHERE user_id = ? ORDER BY created_at DESC"
      )
      .all(userId);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
/** [DELETE] /forms/:id -- Quando deletamos do Sidebar lateral esquerdo */
app.delete("/forms/:id", (req, res) => {
  try {
    const { id } = req.params;
    db.prepare("DELETE FROM epi_forms WHERE id = ?").run(id);
    res.json({ message: "Deletado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const distDir = path.resolve(__dirname, "dist");
const distIndex = path.join(distDir, "index.html");

if (fs.existsSync(distIndex)) {
  app.use(express.static(distDir));

  // Mantem o frontend compilado acessivel no mesmo servidor do backend.
  app.get("*", (_req, res) => {
    res.sendFile(distIndex);
  });
}

/**
 * ==========================================
 * BOOTSTRAP DO SERVIDOR TCP/IP DE RESPOTAS (Finalização)
 * ==========================================
 */
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
