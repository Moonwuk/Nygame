// ruleid: no-sql-string-interpolation
await pool.query(`SELECT * FROM corps WHERE id = ${corpId}`);

// ruleid: no-sql-string-interpolation
await pool.query<Row>(`SELECT ${COLS} FROM corps WHERE id = $1`, [corpId]);

// ok: no-sql-string-interpolation
await pool.query(`SELECT * FROM corps WHERE id = $1`, [corpId]);

// ok: no-sql-string-interpolation
await pool.query<Row>(`SELECT ${COLS} FROM corps WHERE id = $1`, [corpId]); // nosemgrep: no-sql-string-interpolation -- COLS is a fixed column-list constant, not user input
