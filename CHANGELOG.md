# Changelog

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
