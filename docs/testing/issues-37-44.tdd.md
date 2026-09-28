# Issues #37 and #44 TDD evidence (2026-09-28)

Sources: [#37](https://github.com/zhushihao/quantpro-collector/issues/37), [#44](https://github.com/zhushihao/quantpro-collector/issues/44). Journeys: company-facts calls its narrow write tool; an unknown, non-deterministic read failure receives one short retry; read-only Research failure does not block an otherwise viable Automation run.

| Guarantee | Test | RED | GREEN |
| --- | --- | --- | --- |
| Unknown Research read retries once, can recover, and never logs raw error text | `tests/research-read-retry.test.mjs` | Two new cases failed before implementation (`f49aa68`) | 38 targeted retry/adapter tests passed after `fcc3e05` |
| Read-only Automation prompts explicitly preserve fail-soft outcomes | `automation/test_promote.py` | New test failed before prompt change (`c07b613`) | 35 prompt tests passed after `fcc3e05` |
| Company prompt compiles to `append_company_events`, other channels retain their own write tools | `automation/test_promote.py` | New test failed before compiler change (`3f3af0d`) | 35 prompt tests passed after `fcc3e05` |

The full Node test suite and `npm run type-check` passed. `npm run test:coverage` passed with 90.34% line and 93.79% function coverage across all files; aggregate branch coverage was 78.65%, below the skill's 80% target, so that coverage threshold is not claimed. Exact-ref prompt compilation passed and remained under each task's size budget. Production deployment, prompt publication, and natural-run acceptance remain separate issue gates.
