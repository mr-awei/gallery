/**
 * node:sqlite 的「行」是运行时动态结构：同一句 SQL 的列类型取决于表结构，
 * @types/node 只能给出 SQLOutputValue（string | number | bigint | null | Uint8Array）联合类型，
 * 于是 row.abs_path 传给 fs、row.width 参与算术、row.title.toLowerCase() 全都会报假错。
 *
 * 这里只把这个**动态边界**声明清楚：每一行按列名取任意值，语句的 run() 返回数值计数。
 * server/db.js 的 db 句柄标注成 DbHandle 后，server/lib 里其余的 JSDoc
 * （函数参数、返回值、对象字面量、属性访问、可选链）仍然全部真检查。
 */
export interface DbRow {
  [column: string]: any;
}

export interface DbStatement {
  get(...params: any[]): DbRow | undefined;
  all(...params: any[]): DbRow[];
  run(...params: any[]): { changes: number; lastInsertRowid: number };
  iterate?(...params: any[]): Iterable<DbRow>;
}

export interface DbHandle {
  prepare(sql: string): DbStatement;
  exec(sql: string): void;
  transaction(fn: (...args: any[]) => any): (...args: any[]) => any;
  close(): void;
}
