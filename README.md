# Termo EPI Site 2.0

## Como executar

1. Instale as dependências:

```bash
npm install
```

2. Opcionalmente, copie `.env.example` para `.env` e ajuste as variáveis se precisar.

3. Rode o projeto em desenvolvimento:

```bash
npm run dev
```

Isso sobe:

- frontend Vite em `http://localhost:3000`
- backend Express/SQLite em `http://localhost:3001`

## Build local

```bash
npm run build
npm start
```

Depois do build, o backend passa a servir tambem o frontend compilado em `http://localhost:3001`.

## Banco local

- O banco SQLite usado pelo projeto fica em `sistema_v2.db`
- Se ele nao existir, o backend cria a estrutura automaticamente

## Usuários padrão

- `admin` / `admin`
- `user` / `123456`
- `rh` / `M@Reunidos`
