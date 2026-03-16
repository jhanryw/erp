# Usa uma imagem leve do Node.js
FROM node:18-slim

# Define a pasta de trabalho dentro do servidor
WORKDIR /app

# Copia os arquivos de dependências
COPY package*.json ./

# Instala as dependências (express e compression)
RUN npm install --production

# Copia o restante dos arquivos do projeto
COPY . .

# Expõe a porta que o seu server.js usa (3000)
EXPOSE 3000

# Comando para ligar o site
CMD ["node", "server.js"]