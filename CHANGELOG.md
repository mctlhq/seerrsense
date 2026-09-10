# Changelog

## [1.9.0](https://github.com/mctlhq/seerrsense/compare/1.8.0...1.9.0) (2026-09-10)


### Features

* **account:** self-service deletion, a support page, a listing icon, and no PII in logs ([83d386a](https://github.com/mctlhq/seerrsense/commit/83d386a4dcbb03743bcc9f6f03713fbb90749771))
* **account:** self-service deletion, a support page, a listing icon, and no PII in logs ([194883f](https://github.com/mctlhq/seerrsense/commit/194883f95c047afb1857f720254ddb27360f7ea3))
* **mcp:** annotate tools and shape results for the connector directories ([b96a400](https://github.com/mctlhq/seerrsense/commit/b96a400527fe009bf05751c5ed330198ed2326fa))
* **mcp:** annotate tools and shape results for the connector directories ([04d173e](https://github.com/mctlhq/seerrsense/commit/04d173e661b2bb497695a13807842841216f3f50))


### Bug Fixes

* **account:** end every session on deletion, key the e-mail digest, meter the route ([9af49f5](https://github.com/mctlhq/seerrsense/commit/9af49f5a7a2dcf25c255ce39611659b3f2fceb25))
* **account:** fail closed on an iat-less cookie, revoke before deleting, label the limiter ([ab579b2](https://github.com/mctlhq/seerrsense/commit/ab579b2ad8e35588d5dad05b6cfaba19f23b8415))
* **mcp:** name a rejected key from a per-user Seerr, and close the review's P3s ([daf2a3d](https://github.com/mctlhq/seerrsense/commit/daf2a3dcada49e454c11a900c7d648d06b9bb274))
* **mcp:** name whose Seerr failed, treat every 4xx as an error, and clean up the legacy flag in tests ([75db6fa](https://github.com/mctlhq/seerrsense/commit/75db6fa23719d61d93dee428bfa96f133cace6a5))
* **mcp:** say who can fix a Seerr failure, and what a 2xx non-answer means ([095d8ee](https://github.com/mctlhq/seerrsense/commit/095d8ee970d729cf6f78679cc6e9db7172714c7b))

## [1.8.0](https://github.com/mctlhq/seerrsense/compare/1.7.0...1.8.0) (2026-09-09)


### Features

* **agents:** issue-49-account-the-page-promises-a-shared-seerr ([1ef1841](https://github.com/mctlhq/seerrsense/commit/1ef18410eb4377b71cb4a531b201e4e4ff16cfed))


### Bug Fixes

* **account:** tell the person when signing out did not work ([820bc39](https://github.com/mctlhq/seerrsense/commit/820bc392e29b2bb385097a2bb548f0c02ca8cef5))
* make householdFallback the only admission rule, and stop the disconnect handler claiming success ([742375e](https://github.com/mctlhq/seerrsense/commit/742375eb9a77a2fb225b345a112fc46addf574a3))
* report the real household fallback and add account sign-out ([7e3b854](https://github.com/mctlhq/seerrsense/commit/7e3b8540fecf14107966b6b972394c26df2da42b))

## [1.7.0](https://github.com/mctlhq/seerrsense/compare/1.6.0...1.7.0) (2026-09-09)


### Features

* **agents:** issue-44-auth-public-mode-open-signup-household-o ([3943294](https://github.com/mctlhq/seerrsense/commit/3943294fe75ea8feabdefa34ef87311cac49218a))
* **agents:** issue-45-docs-the-landing-page-instructs-a-bearer ([534f7c2](https://github.com/mctlhq/seerrsense/commit/534f7c223158f108bd339d01730fa20533e67493))
* **auth:** open signup, owner-only household, SSRF guard, rate and model budgets ([9b68ba2](https://github.com/mctlhq/seerrsense/commit/9b68ba295b279c7d6b24720e82712177380167da))


### Bug Fixes

* close the re-review's P1 and two P2 findings ([845c393](https://github.com/mctlhq/seerrsense/commit/845c3935fb28ea85bc2f60fac4cfc577d5c2a5bf))
* close the review's P1 and P2 findings ([2acbb14](https://github.com/mctlhq/seerrsense/commit/2acbb1465c2e787bce0857e3dadf690aa3b61766))

## [1.6.0](https://github.com/mctlhq/seerrsense/compare/1.5.0...1.6.0) (2026-09-09)


### Features

* **agents:** issue-39-consent-cloudflare-email-obfuscation-rep ([7c1a8f0](https://github.com/mctlhq/seerrsense/commit/7c1a8f0dd2ee9a42db2f41e7d2eaddd2a9884cf1))


### Bug Fixes

* **consent:** keep signed-in address readable under email obfuscation ([cd40425](https://github.com/mctlhq/seerrsense/commit/cd404251d3fea2818d296b214246ca8ca475e3f0))
* drop an accidentally committed node_modules symlink ([bd2c969](https://github.com/mctlhq/seerrsense/commit/bd2c9694187a63d643e2e3b786b6ea32417f03c6))

## [1.5.0](https://github.com/mctlhq/seerrsense/compare/1.4.5...1.5.0) (2026-09-09)


### Features

* pin the vendored tokens to a versioned CDN path ([ec474c1](https://github.com/mctlhq/seerrsense/commit/ec474c1f6eccaee9a4b2144a4f075cfe9b93b20a))
* pin the vendored tokens to a versioned CDN path ([304ed6e](https://github.com/mctlhq/seerrsense/commit/304ed6e5064ed3f4d50b423ce509a220cd445a57))

## [1.4.5](https://github.com/mctlhq/seerrsense/compare/1.4.4...1.4.5) (2026-09-09)


### Bug Fixes

* the consent screen's layout never reaches the browser ([954cfd3](https://github.com/mctlhq/seerrsense/commit/954cfd35d7e30c5292cdd6792875b6e58e7290cf))
* the consent screen's layout never reaches the browser ([51ef64c](https://github.com/mctlhq/seerrsense/commit/51ef64cb6d77df9552db109ff091a072226d429d))

## [1.4.4](https://github.com/mctlhq/seerrsense/compare/1.4.3...1.4.4) (2026-09-09)


### Bug Fixes

* bound the intent model call so a rambling answer cannot hang a request ([83b1538](https://github.com/mctlhq/seerrsense/commit/83b15386a8cc699c83e6939f04e01fe0ffa4a12d))
* bound the intent model call so a rambling answer cannot hang a request ([b759f15](https://github.com/mctlhq/seerrsense/commit/b759f15f3ea3adc1fd479eeb98cfcd348e4459f8))

## [1.4.3](https://github.com/mctlhq/seerrsense/compare/1.4.2...1.4.3) (2026-09-09)


### Bug Fixes

* strip parentheses from Seerr search terms ([fc30e10](https://github.com/mctlhq/seerrsense/commit/fc30e10b0800a496606fae31e400d18e69335a3e))
* strip parentheses from Seerr search terms ([89d9274](https://github.com/mctlhq/seerrsense/commit/89d9274b3e51b7369d4a10a27008d97aca535186))

## [1.4.2](https://github.com/mctlhq/seerrsense/compare/1.4.1...1.4.2) (2026-09-09)


### Bug Fixes

* let the model name the film it recognises ([b112dc9](https://github.com/mctlhq/seerrsense/commit/b112dc9d3221ba559f9ae010996611ca19bd0f17))
* let the model name the film it recognises ([18ac2c6](https://github.com/mctlhq/seerrsense/commit/18ac2c651fce04db98e3f00057776550dd0ad2a7)), closes [#27](https://github.com/mctlhq/seerrsense/issues/27)

## [1.4.1](https://github.com/mctlhq/seerrsense/compare/1.4.0...1.4.1) (2026-09-09)


### Bug Fixes

* resolve the MCP tenant from AuthInfo instead of the Node request ([4b56f54](https://github.com/mctlhq/seerrsense/commit/4b56f54aa71669c62d96c9dda3e239bf8125376b))
* resolve the MCP tenant from AuthInfo instead of the Node request ([84362b2](https://github.com/mctlhq/seerrsense/commit/84362b2ceba598abf4697a0d7ad646a6daadf28f))

## [1.4.0](https://github.com/mctlhq/seerrsense/compare/1.3.0...1.4.0) (2026-09-09)


### Features

* **web:** add the privacy and terms pages ([9daddec](https://github.com/mctlhq/seerrsense/commit/9daddecb8e121fb4398a02eb4b9ee7ebb35f775a))
* **web:** add the privacy and terms pages ([33aa039](https://github.com/mctlhq/seerrsense/commit/33aa039e88313dde187803d2e131da1aa29d6466))


### Bug Fixes

* **auth:** register the account page as a client of this server ([9a9a9ad](https://github.com/mctlhq/seerrsense/commit/9a9a9ad326a2f1b48a6affb2b17b3d1f99b5eba5))
* **auth:** register the account page as a client of this server ([503f144](https://github.com/mctlhq/seerrsense/commit/503f14420b4381c4f558d3a1eff674220a035b6a))

## [1.3.0](https://github.com/mctlhq/seerrsense/compare/1.2.0...1.3.0) (2026-09-09)


### Features

* **account:** a page for attaching your own Seerr ([081dd81](https://github.com/mctlhq/seerrsense/commit/081dd81dceebf36f58d8e137c4c0e1d1222d718f))
* **account:** a page for attaching your own Seerr ([823c629](https://github.com/mctlhq/seerrsense/commit/823c629235eb28e62012ca31ceeeb73c71e027e5)), closes [#3](https://github.com/mctlhq/seerrsense/issues/3)
* **tenancy:** let each person use their own Seerr ([4e4b7fe](https://github.com/mctlhq/seerrsense/commit/4e4b7fe07518f8565b95ac54a044c66c1ca33f4c))
* **tenancy:** let each person use their own Seerr ([fa5d4e1](https://github.com/mctlhq/seerrsense/commit/fa5d4e170d5c770603a75fd9280d59476175f356)), closes [#3](https://github.com/mctlhq/seerrsense/issues/3)


### Bug Fixes

* **auth:** meet what the OpenAI and Anthropic connectors actually require ([2a61564](https://github.com/mctlhq/seerrsense/commit/2a615642abe2e6022a7aec6cc5251769ad493e32))
* **auth:** meet what the OpenAI and Anthropic connectors actually require ([e89e9f7](https://github.com/mctlhq/seerrsense/commit/e89e9f7c979619e7d083f635750d7f162ccc7082))

## [1.2.0](https://github.com/mctlhq/seerrsense/compare/1.1.0...1.2.0) (2026-09-08)


### Features

* **auth:** OAuth 2.1 for /mcp with Google as the identity provider ([73a22d9](https://github.com/mctlhq/seerrsense/commit/73a22d9655973adb1ed7f2b537de6e1335f2856d))
* **auth:** OAuth 2.1 for /mcp with Google as the identity provider ([5bd2b02](https://github.com/mctlhq/seerrsense/commit/5bd2b023b3d20ef171c47816e0f62f4172ceea13)), closes [#8](https://github.com/mctlhq/seerrsense/issues/8)
* **web:** add the SeerrSense landing page ([94f3a1c](https://github.com/mctlhq/seerrsense/commit/94f3a1c1c2b8e99551758147c63b84928f77cd53))
* **web:** add the SeerrSense landing page ([c54d90e](https://github.com/mctlhq/seerrsense/commit/c54d90e717c15fccff6ca5ed2c99513447250972)), closes [#6](https://github.com/mctlhq/seerrsense/issues/6)

## [1.1.0](https://github.com/mctlhq/seerrsense/compare/1.0.5...1.1.0) (2026-09-08)


### Features

* add cloudflare access service token support for zero trust ([c844425](https://github.com/mctlhq/seerrsense/commit/c844425b53d21adb00e2ae9b100161839dc84604))
* add cloudflare access service token support for zero trust ([b672148](https://github.com/mctlhq/seerrsense/commit/b672148de51037c2cd9b1927a71898496d24b2f5))
* add stdio transport and binary release workflow ([60ae180](https://github.com/mctlhq/seerrsense/commit/60ae1806a5c976da7cafdb81c562ad10eeb7b136))
* add stdio transport and binary release workflow ([1c05bcd](https://github.com/mctlhq/seerrsense/commit/1c05bcdf92d043e92b1897c1c3daea5ae0a05a42))


### Bug Fixes

* **stdio:** use SDK v2 stdio transport, keep stdout clean, make auth token HTTP-only ([7045c04](https://github.com/mctlhq/seerrsense/commit/7045c049e0cab61ca67790dd34b42bc0b72a1b69))
