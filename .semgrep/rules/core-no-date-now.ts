// ruleid: core-no-date-now
const t1 = Date.now();

// ruleid: core-no-date-now
const t2 = new Date();

// ruleid: core-no-date-now
const t3 = new Date(1234);

// ok: core-no-date-now
function ok(ctx: { now: number }) {
  return ctx.now;
}
