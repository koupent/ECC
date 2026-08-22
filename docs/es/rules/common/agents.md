# Orquestación de Agentes

## Agentes Disponibles

Ubicados en `~/.claude/agents/`:

| Agente | Propósito | Cuándo Usar |
|--------|-----------|-------------|
| planner | Planificación de implementación | Features complejas, refactoring |
| architect | Diseño de sistemas | Decisiones arquitectónicas |
| tdd-guide | Desarrollo guiado por pruebas | Nuevas features, corrección de bugs |
| code-reviewer | Revisión de código | Después de escribir código |
| security-reviewer | Análisis de seguridad | Antes de los commits |
| build-error-resolver | Corrección de errores de build | Cuando el build falla |
| e2e-runner | Testing E2E | Flujos de usuario críticos |
| refactor-cleaner | Limpieza de código muerto | Mantenimiento de código |
| doc-updater | Documentación | Actualización de docs |
| rust-reviewer | Revisión de código Rust | Proyectos Rust |
| harmonyos-app-resolver | Desarrollo de apps HarmonyOS | Proyectos HarmonyOS/ArkTS |

## Política de Uso de Agentes

`rules/common/agents.md` es la política canónica de delegación; este documento es su traducción.

**Alcance.** Esta política rige cada paso "usa el agente X" de las demás reglas de este pack, por
absoluto que sea su enunciado. Lee cada uno de esos pasos como "delega cuando esta política lo
permita".

**Mecanismo.** Esta regla describe cuándo la delegación es útil; no lanza un agente
automáticamente, y ningún runtime lo lanza por su cuenta. Un agente se ejecuta solo cuando el
modelo padre invoca una herramienta Agent o Task disponible y recoge su resultado.

**Expectativa.** Cuando esa herramienta está disponible y las instrucciones de mayor prioridad lo
permiten, decide por tu cuenta si delegar. No hace falta una solicitud aparte del usuario.

**Precedencia.** Las instrucciones de mayor prioridad del sistema, del runtime o harness, de la
organización y del usuario siempre prevalecen sobre esta regla. Cuando el harness restringe la
delegación —por ejemplo, "no llames a la herramienta Agent salvo que el usuario lo pida"— sigue al
harness. Entonces esta regla indica qué perspectivas cubrir, no que puedas anular la restricción.

Cuando las herramientas de delegación están disponibles y las instrucciones de mayor prioridad
permiten su uso:
1. Solicitudes de features complejas - Considerar el agente **planner**
2. Código recién escrito/modificado - Considerar el agente **code-reviewer**
3. Corrección de bug o nueva feature - Considerar el agente **tdd-guide**
4. Decisión arquitectónica - Considerar el agente **architect**

Cuando la delegación no está disponible o está prohibida, mantén el trabajo en el contexto padre y
aplica allí las mismas listas de verificación de planificación, pruebas y revisión. Nunca afirmes
que un agente se ejecutó si no hubo invocación de la herramienta ni recolección del resultado.

## Ejecución Paralela de Tareas

Usa ejecución paralela de tareas solo para operaciones realmente independientes, cuando el runtime
permita la delegación y el padre pueda recoger todos los resultados antes de terminar su turno. La
delegación sin seguimiento está prohibida:

```markdown
# CORRECTO: Ejecución paralela
Lanzar 3 agentes en paralelo:
1. Agente 1: Análisis de seguridad del módulo de auth
2. Agente 2: Revisión de rendimiento del sistema de caché
3. Agente 3: Verificación de tipos de las utilidades

# INCORRECTO: Secuencial cuando no es necesario
Primero agente 1, luego agente 2, luego agente 3
```

## Análisis Multi-Perspectiva

Para problemas complejos, considera sub-agentes con roles divididos cuando la delegación esté
permitida y las perspectivas sean realmente independientes:
- Revisor factual
- Ingeniero senior
- Experto en seguridad
- Revisor de consistencia
- Verificador de redundancias

Cuando la delegación no está disponible, recorre esas mismas perspectivas como pasadas separadas
en el contexto padre. Lo que detecta los defectos que se le escapan a una revisión limitada al
diff —por ejemplo, un orden de pasos incorrecto en un procedimiento cuyo diff toca una sola
línea— es la perspectiva; el agente es solo el vehículo.
