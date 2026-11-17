const sqlite3 = require("sqlite3").verbose();

// Conecta ao seu banco de dados atual
const db = new sqlite3.Database("./sistema_v2.db", err => {
  if (err) {
    return console.error(err.message);
  }
  console.log("Conectado ao banco de dados.");
});

// Executa a atualização da senha
const novaSenha = "admin";
const usuarioAlvo = "admin";

db.run(
  `UPDATE users SET password = ? WHERE username = ?`,
  [novaSenha, usuarioAlvo],
  function (err) {
    if (err) {
      return console.error(err.message);
    }
    console.log(`Sucesso! A senha do usuário '${usuarioAlvo}' foi alterada.`);
    console.log(`Linhas afetadas: ${this.changes}`);
  }
);

// Fecha a conexão
db.close();
