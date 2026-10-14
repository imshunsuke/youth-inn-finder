// Invocation-local counters only. Never retain SQL, bindings or returned rows.
export function measureD1Usage(database) {
  const originals=new WeakMap();
  const counts={statements:0,rowsRead:0,rowsWritten:0,missingMeta:0,failures:0};
  function record(result) {
    counts.statements++;
    const meta=result?.meta;
    if(!Number.isSafeInteger(meta?.rows_read)||meta.rows_read<0||!Number.isSafeInteger(meta?.rows_written)||meta.rows_written<0) {
      counts.missingMeta++;return;
    }
    counts.rowsRead+=meta.rows_read;counts.rowsWritten+=meta.rows_written;
  }
  async function execute(work) {
    try {const result=await work();record(result);return result;}
    catch(error){counts.failures++;throw error;}
  }
  function wrap(original) {
    const statement={
      bind:(...values)=>wrap(original.bind(...values)),
      all:()=>execute(()=>original.all()),run:()=>execute(()=>original.run()),
      async first(column) {
        // D1 first() drops meta. all() executes the same SQL once and preserves
        // metadata, including INSERT/UPDATE ... RETURNING used for leases.
        const result=await execute(()=>original.all()),row=result.results?.[0];
        if(!row)return null;
        if(column===undefined)return row;
        if(!Object.hasOwn(row,column))throw new Error('D1 result column unavailable');
        return row[column];
      },
      async raw(options) {counts.missingMeta++;return original.raw(options);},
    };
    originals.set(statement,original);return statement;
  }
  return {db:{
    prepare:sql=>wrap(database.prepare(sql)),
    async batch(statements) {
      try {
        const result=await database.batch(statements.map(statement=>{
          const original=originals.get(statement);if(!original)throw new TypeError('Statement belongs to another database');return original;
        }));
        result.forEach(record);return result;
      }catch(error){counts.failures++;throw error;}
    },
    async exec(sql){counts.missingMeta++;return database.exec(sql);},
  },summary:()=>({...counts,complete:counts.missingMeta===0&&counts.failures===0})};
}
