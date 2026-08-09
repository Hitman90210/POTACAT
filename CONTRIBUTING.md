# Contributing to POTACAT

Thanks for helping. Two licensing facts shape contributions here:

1. **The combined work is GPLv3** (see `LICENSE`), because POTACAT compiles in
   the JS8 modem from JS8Call (GPLv3).
2. **Files authored for POTACAT are headed `SPDX-License-Identifier:
   Apache-2.0`.** The copyright holder keeps them individually available under
   Apache-2.0; the combination you build and run is GPLv3.

## License grant for contributions

To keep that structure intact, contributions to Apache-2.0-headed files must
be made under the Apache License 2.0. By submitting a pull request you agree
that:

- Your contribution is licensed to the project under the **Apache License
  2.0**, and may be distributed by the project as part of a GPLv3 combined
  work.
- You have the right to license the code you are contributing (it is your own
  work, or you have permission to submit it under these terms).

Sign your commits with `git commit -s` (Developer Certificate of Origin,
<https://developercertificate.org/>). The DCO sign-off line records the
statement above.

Contributions **to files under `third_party/`** follow the upstream license of
that component (JS8Call code is GPLv3 — changes there are best sent upstream).

## Practical notes

- `npm start` runs the app; `npm test` runs the suite. Both should pass before
  a PR.
- Native addons: `npm run build-ft8`, `npm run build-js8`. gyp files take `#`
  comments only.
- "POTACAT" and "ECHOCAT" are trademarks — forks that redistribute modified
  builds must rename (see `TRADEMARKS.md`).
