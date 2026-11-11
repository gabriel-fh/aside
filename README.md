# Aside

Assistente flutuante para Windows que acompanha reuniões, aulas e sessões de estudo em tempo real. Projeto pessoal, sem conta, sem pagamento e sem telemetria.

## O que faz

- Overlay transparente, sempre no topo, que deixa o clique passar pelas áreas vazias.
- Captura o microfone (Eu) e o áudio do computador (Eles) e transcreve cada fala.
- Responde perguntas com base na conversa, e na tela quando você pede.
- Sugere uma resposta sozinho quando alguém faz uma pergunta.
- Tradução ao vivo das falas.
- Modos (Reunião, Entrevista, Estudo e código, Geral e os que você criar), cada um com instruções e contexto próprios: anotações escritas e arquivos PDF, DOCX ou texto.
- Histórico local em SQLite, com busca, resumo e exportação em Markdown (inclusive para um cofre do Obsidian).
- Modo stealth: as janelas somem de capturas e compartilhamento de tela, e da barra de tarefas.
- Atalhos globais configuráveis.

## Configuração guiada

Na primeira abertura o Aside mostra a Configuração guiada: um clique instala a transcrição recomendada para o computador (Whisper na placa NVIDIA, ou na CPU) e um campo recebe a chave do Groq, que é testada na hora. As telas Ajustes e Usar offline marcam com "Recomendado" o que vale instalar.

## Ouvinte de reunião

O modo Ouvinte de reunião só registra a conversa, sem sugerir respostas. Ao encerrar a sessão ele gera a ata (resumo, tópicos, decisões e pendências) e salva tudo em Markdown em `DocumentosAside`, ou na subpasta Aside do cofre do Obsidian. Em qualquer modo, o botão "Salvar em Markdown" da aba Transcrição faz o mesmo na hora. Conversas longas são resumidas por trechos, para caber no limite de serviços gratuitos.

## Como rodar

```bash
npm install
npm start
```

Na primeira execução, abra Ajustes e informe uma chave do [OpenRouter](https://openrouter.ai/keys). A chave fica cifrada no cofre de credenciais do Windows.

## Modelos

Tudo passa pelo OpenRouter, então qualquer modelo da lista serve para as respostas (Claude, Gemini, GPT e outros). A transcrição usa um modelo que aceite áudio como entrada; a tela de Ajustes avisa quando o modelo escolhido não aceita.

## Atalhos padrão

| Ação | Atalho |
| --- | --- |
| Mostrar ou ocultar | `Control+Shift+Space` |
| Iniciar ou parar a sessão | `Control+Shift+K` |
| Perguntar com base na conversa | `Control+Shift+Enter` |
| Analisar a tela | `Control+Shift+L` |
| Perguntar sobre o texto selecionado | `Control+Shift+E` |
| Mover o overlay | `Control+Alt+Setas` |

## Estrutura

- `src/main`: processo principal (janelas, atalhos, banco, chamadas ao OpenRouter).
- `src/renderer`: overlay, captura de áudio e janela de ajustes.
- `src/preload.js`: ponte entre a interface e o processo principal.

Os dados ficam em `%APPDATA%\aside` (`settings.json` e `aside.db`).

## Outros serviços de IA

Em Ajustes, "Usar outro serviço de IA nas respostas" aceita qualquer serviço compatível com a API da OpenAI: Google Gemini (AI Studio), Groq, Cerebras, Mistral, DeepSeek ou um Ollama local. Informe o endereço, a chave e o modelo. A transcrição continua pelo OpenRouter ou pelo Whisper local.

## Entrevistas

O modo Entrevista guarda uma ficha por vaga: nome da vaga, tipo de entrevista (RH, técnica em bate-papo, código ao vivo, desafio técnico, mista ou com gestor), o currículo enviado para aquela vaga, a descrição e anotações. O Aside usa a vaga selecionada.

## Modo local

Na aba Local dos Ajustes dá para rodar tudo neste computador, sem chave:

- Transcrição com whisper.cpp. Instale o motor, baixe um modelo e escolha "Whisper local".
- Respostas com llama.cpp. Instale o motor, baixe ou aponte um arquivo `.gguf` e escolha "Modelo local".

Os motores vêm das builds oficiais no GitHub e os modelos do Hugging Face. Tudo fica em `%APPDATA%\aside\local`. O modelo local não lê imagens.

## Ferramentas (MCP)

Na aba Ferramentas você cadastra servidores MCP, por comando local (stdio) ou endereço HTTP. Quando você faz uma pergunta, o modelo pode chamar essas ferramentas. Ferramentas marcadas como só leitura rodam direto; as outras pedem confirmação, a menos que o servidor esteja marcado como de confiança. Sugestões automáticas não usam ferramentas.

A configuração dos servidores fica cifrada, porque pode conter tokens.

## Testes de desenvolvimento

```bash
ASIDE_MCP_TEST=1 npx electron .
```

Conecta ao servidor de exemplo em `dev/mcp-test-server.js` e roda o laço de ferramentas contra um provedor falso.

## Ainda não tem

- Login por navegador (OAuth) em servidores MCP remotos.
- Ferramentas MCP com o modelo local.
- Instalador.

## Gerar o executável

```
npm run dist
```

Saem dois arquivos em `dist/`: o instalador (`Aside-<versão>-instalador.exe`) e a versão portátil, que roda sem instalar (`Aside-<versão>-portatil.exe`). Os executáveis não são assinados, então o Windows pode mostrar o aviso do SmartScreen na primeira abertura.
