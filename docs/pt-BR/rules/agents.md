# Orquestração de Agentes

## Agentes Disponíveis

Localizados em `~/.claude/agents/`:

| Agente | Propósito | Quando Usar |
|--------|-----------|-------------|
| planner | Planejamento de implementação | Recursos complexos, refatoração |
| architect | Design de sistema | Decisões arquiteturais |
| tdd-guide | Desenvolvimento orientado a testes | Novos recursos, correção de bugs |
| code-reviewer | Revisão de código | Após escrever código |
| security-reviewer | Análise de segurança | Antes de commits |
| build-error-resolver | Corrigir erros de build | Quando o build falha |
| e2e-runner | Testes E2E | Fluxos críticos do usuário |
| refactor-cleaner | Limpeza de código morto | Manutenção de código |
| doc-updater | Documentação | Atualização de docs |
| rust-reviewer | Revisão de código Rust | Projetos Rust |

## Política de Uso de Agentes

`rules/common/agents.md` é a política canônica de delegação; este documento é a tradução dela.

**Escopo.** Esta política rege cada passo "use o agente X" das demais regras deste pacote, por
mais absoluto que seja o enunciado. Leia cada um desses passos como "delegue quando esta política
permitir".

**Mecanismo.** Esta regra descreve quando delegar é útil; ela não inicia um agente
automaticamente, e nenhum runtime inicia um por conta própria. Um agente só executa quando o
modelo pai invoca uma ferramenta Agent ou Task disponível e recolhe o resultado.

**Expectativa.** Quando essa ferramenta está disponível e as instruções de maior prioridade
permitem, decida por conta própria se deve delegar. Não é preciso um pedido separado do usuário.

**Precedência.** Instruções de maior prioridade do sistema, do runtime ou harness, da organização
e do usuário sempre prevalecem sobre esta regra. Quando o harness restringe a delegação — por
exemplo, "não chame a ferramenta Agent a menos que o usuário peça" — siga o harness. Nesse caso
esta regra indica quais perspectivas cobrir, e não permissão para anular a restrição.

Quando as ferramentas de delegação estão disponíveis e as instruções de maior prioridade permitem
seu uso:
1. Solicitações de recursos complexos - Considere o agente **planner**
2. Código acabado de escrever/modificar - Considere o agente **code-reviewer**
3. Correção de bug ou novo recurso - Considere o agente **tdd-guide**
4. Decisão arquitetural - Considere o agente **architect**

Quando a delegação não está disponível ou é proibida, mantenha o trabalho no contexto pai e
aplique ali as mesmas listas de verificação de planejamento, testes e revisão. Nunca afirme que um
agente executou sem que tenha havido invocação da ferramenta e coleta do resultado.

## Execução Paralela de Tarefas

Use execução paralela de Task apenas para operações realmente independentes, quando o runtime
permitir a delegação e o pai puder recolher todos os resultados antes de encerrar seu turno.
Delegação sem coleta de resultado é proibida:

```markdown
# BOM: Execução paralela
Iniciar 3 agentes em paralelo:
1. Agente 1: Análise de segurança do módulo de autenticação
2. Agente 2: Revisão de desempenho do sistema de cache
3. Agente 3: Verificação de tipos dos utilitários

# RUIM: Sequencial quando desnecessário
Primeiro agente 1, depois agente 2, depois agente 3
```

## Análise Multi-Perspectiva

Para problemas complexos, considere subagentes com papéis divididos quando a delegação for
permitida e as perspectivas forem realmente independentes:
- Revisor factual
- Engenheiro sênior
- Especialista em segurança
- Revisor de consistência
- Verificador de redundância

Quando a delegação não estiver disponível, percorra as mesmas perspectivas como passagens
separadas no contexto pai. O que detecta as falhas que escapam a uma revisão limitada ao diff —
por exemplo, a ordem errada dos passos em um procedimento cujo diff altera uma única linha — é a
perspectiva; o agente é apenas o veículo.
