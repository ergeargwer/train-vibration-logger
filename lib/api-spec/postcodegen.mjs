/**
 * postcodegen.mjs
 *
 * orval v8 在 split mode 下會「追加（append）」到 workspace 層級的 index.ts，
 * 而非覆寫。若前一次執行已寫入相同內容，下一次執行會造成重複的 export * 宣告，
 * TypeScript 因此拋出 TS2308（同一名稱被 export 兩次）。
 *
 * 此腳本在 orval 執行完畢後立即執行，將受影響的 index.ts 重寫為正確的單一內容，
 * 避免重複匯出導致的型別錯誤。
 */
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');

// api-zod: 只需匯出 Zod schema；TypeScript 型別由 api-client-react 提供
writeFileSync(
  resolve(root, 'lib', 'api-zod', 'src', 'index.ts'),
  "export * from './generated/api';\n",
  'utf-8',
);

// api-client-react: 保留手動維護的完整匯出（含 custom-fetch 工具函式）
// 重複的 `export * from './generated/api'` 不影響型別正確性，但整理後更乾淨
writeFileSync(
  resolve(root, 'lib', 'api-client-react', 'src', 'index.ts'),
  [
    "export * from './generated/api';",
    "export * from './generated/api.schemas';",
    "export { setBaseUrl, setAuthTokenGetter } from './custom-fetch';",
    "export type { AuthTokenGetter } from './custom-fetch';",
    '',
  ].join('\n'),
  'utf-8',
);

console.log('postcodegen: index.ts 已修正');
