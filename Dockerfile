# 1. Usa o Node 20 (necessário para o Supabase)
FROM node:20-slim

WORKDIR /app

# 2. Copia os arquivos de dependências
COPY package*.json ./

# 3. Instala as dependências (omitindo as de desenvolvimento)
RUN npm install --omit=dev

# 4. Copia o RESTO dos arquivos (Isso inclui o seu server.js)
COPY . .

# 5. O PULO DO GATO: 
# Verifique se o seu arquivo principal é 'server.js' ou 'index.js'.
# Se ele estiver dentro de uma pasta 'src', mude para ["node", "src/server.js"]
CMD ["node", "server.js"]
