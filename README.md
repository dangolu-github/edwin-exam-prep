# Sydney Foundation Course Portal

Published course materials for one student, served by GitHub Pages at
https://dangolu-github.github.io/edwin-exam-prep/

Every page in this repository is stored as AES-256-GCM ciphertext (`*.enc`) behind a small wrapper
page (`*.html`). The wrapper asks the private course service for the key, and only a reader who
knows this course’s shared code, or who opens a valid teacher preview link, gets it. The key is not
in this repository and never has been, so the pages’ contents — which include one learner’s own
answers and the feedback written on them — are not readable here or anywhere in this repository’s
history.

The shared code is a convenience gate, not an identity check. Anyone it is given to can read these
pages.

Do not add a plaintext page to this repository. Pages are written in the private source tree and
published with `backend/tools/build_site_release.mjs`; the `.sf02-public-encrypted` marker file in this
directory makes the portal builders refuse to write plaintext learner HTML here.

Audio and transcripts in sections 03–05 are credited on the pages that use them. Section 01 uses the
course listening booklet and section 02 a TED talk, each credited on its own page.
