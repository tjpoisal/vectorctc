# Bring your own key (semantic step)

The deterministic gate never calls a model. The optional semantic step (it reviews a diff the gate already
cleared, against the plan objective, the ticket and the invariants) runs only when a key is present.

| Variable | Meaning |
|---|---|
| `CTC_SEMANTIC_API_KEY` or `CTC_SEMANTIC_API_KEY_FILE` | Your key, or a file holding it (Kubernetes/Docker secret, vault agent sink). Never logged. |
| `CTC_SEMANTIC_PROVIDER` | `openai` (any OpenAI-compatible `/chat/completions`) or `anthropic`. |
| `CTC_SEMANTIC_BASE_URL` | Your endpoint: Azure/AI gateway proxy, vLLM, Ollama (`http://localhost:11434/v1`), LiteLLM, etc. |
| `CTC_SEMANTIC_MODEL` | Model id. |
| `CTC_SEMANTIC=off` | Force it off. |

Data sent: the file path, the diff, numbered lines around the change, the plan objective / ticket, invariants
and the deterministic findings. Nothing else from the repo. Point `CTC_SEMANTIC_BASE_URL` at a model inside your
network and no code leaves it. `rules.semantic.mode` in `ctc.config.json` chooses `warn` (default) or `block`.
