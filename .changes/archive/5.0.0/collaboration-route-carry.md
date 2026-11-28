---
category: Fixed
packages: engine
---

- **Carried pre-route move rows are labelled by the generation's own v5 rule**: a replacement that carries a predecessor ledger without the `route` column now computes each half's route from the row's role and the predecessor's own recorded mode, instead of leaving the successor's `local-local` column default on the row — a default that made the discard of a remote exchange half refuse as a one-checkout move and left it stuck.
