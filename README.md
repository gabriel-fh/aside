# Aside

Assistente flutuante para Windows que acompanha reuniões, aulas e sessões de estudo em tempo real. Projeto pessoal, sem conta, sem pagamento e sem telemetria.

## O que faz

- Overlay transparente, sempre no topo, que deixa o clique passar pelas áreas vazias.
- Captura o microfone (Eu) e o áudio do computador (Eles) e transcreve cada fala.
- Responde perguntas com base na conversa, e na tela quando você pede.
- Sugere uma resposta sozinho quando alguém faz uma pergunta.
- Tradução ao vivo das falas.
- Assistentes com instruções próprias, editáveis.
- Histórico local em SQLite, com busca, resumo e exportação em Markdown (inclusive para um cofre do Obsidian).
- Modo stealth: as janelas somem de capturas e compartilhamento de tela, e da barra de tarefas.
- Atalhos globais configuráveis.

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
| Mover o overlay | `Control+Alt+Setas` |

## Estrutura

- `src/main`: processo principal (janelas, atalhos, banco, chamadas ao OpenRouter).
- `src/renderer`: overlay, captura de áudio e janela de ajustes.
- `src/preload.js`: ponte entre a interface e o processo principal.

Os dados ficam em `%APPDATA%\aside` (`settings.json` e `aside.db`).

## Ainda não tem

- Transcrição e modelo locais (whisper.cpp e llama.cpp).
- Ferramentas conectadas via MCP.
- Instalador.
