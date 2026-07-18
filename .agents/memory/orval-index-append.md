---
name: Orval split-mode workspace index append behavior
description: orval v8 在 split mode 下每次 codegen 會追加（不是覆寫）workspace 層級的 index.ts，造成重複 export * 與 TS2308 錯誤。解法是 postcodegen.mjs 腳本。
---

## 問題

orval v8（split mode + workspace 設定）每次執行 `orval --config ...` 時，
會把新的 export 行**追加**到 `lib/api-zod/src/index.ts`（workspace 層級），
而非覆寫。若同一 module 被 `export *` 兩次，TypeScript 會拋出：

```
TS2308: Module "./generated/api" has already exported a member named 'StartTripBody'.
```

還原 schemas 設定（`schemas: { path: "generated/types", type: "typescript" }`）
會使 Zod schema const 與 TypeScript interface 同名，再加重複 export，兩個錯誤疊加。

## 解法

1. 移除 orval config 的 `schemas: { path: "generated/types", ... }` 設定
   （api-zod 只需 Zod schemas；TypeScript types 由 api-client-react 提供）

2. 新增 `lib/api-spec/postcodegen.mjs`，在 orval 執行後強制覆寫受影響的 index.ts

3. 修改 `lib/api-spec/package.json` codegen script：
   ```
   orval --config ./orval.config.ts && node ./postcodegen.mjs && pnpm -w run typecheck:libs
   ```

**Why:** orval 的 workspace index 設計為手動維護，但 split mode 下它又自動追加，
造成每次 codegen 都積累重複 export。postcodegen.mjs 是明確的「最後寫入者獲勝」策略。

**How to apply:** 每次新增 openapi.yaml schema 後執行 codegen 時，
postcodegen.mjs 會自動修正兩個 index.ts，不需手動介入。
