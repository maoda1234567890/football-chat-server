// 绾� JS JSON 鏂囦欢鏁版嵁搴擄紙鍏煎 better-sqlite3 甯哥敤 API锛屾棤闇€鍘熺敓缂栬瘧锛�
const fs = require('fs');
const path = require('path');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const dbPath = path.join(dataDir, 'database.json');

// 鍐呭瓨鏁版嵁
let data = {
  users: [],
  friendships: [],
  messages: [],
  _seq: { users: 0, friendships: 0, messages: 0 }
};

// 鍔犺浇宸叉湁鏁版嵁
if (fs.existsSync(dbPath)) {
  try {
    const raw = fs.readFileSync(dbPath, 'utf8');
    const loaded = JSON.parse(raw);
    data = Object.assign(data, loaded);
  } catch (e) {
    console.error('[DB] 鍔犺浇鏁版嵁澶辫触锛屼娇鐢ㄧ┖鏁版嵁搴�:', e.message);
  }
}

let saveTimer = null;
function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('[DB] 淇濆瓨澶辫触:', e.message);
    }
  }, 100);
}

function nextId(table) {
  data._seq[table] = (data._seq[table] || 0) + 1;
  return data._seq[table];
}

// 灏� SQL 涓殑 ? 鏇挎崲涓哄弬鏁�
function fillParams(sql, params) {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = params[i++];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return v;
    return "'" + String(v).replace(/'/g, "''") + "'";
  });
}

// 绠€鏄� SQL 瑙ｆ瀽鍣細鍙敮鎸佹湰椤圭洰鐢ㄥ埌鐨勮鍙�
function execSQL(sql, params = [], isGet = false) {
  const s = sql.trim().replace(/\s+/g, ' ');
  const upper = s.toUpperCase();

  // INSERT INTO users (...)
  let m;
  if ((m = upper.match(/^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)/))) {
    const table = m[1].toLowerCase();
    const cols = m[2].split(',').map(c => c.trim());
    const values = params;
    const row = { id: nextId(table) };
    cols.forEach((c, i) => {
      let v = values[i];
      if (c === 'created_at' && v === undefined) v = new Date().toISOString();
      row[c] = v !== undefined ? v : null;
    });
    // 榛樿鍊�
    if (table === 'users') {
      if (row.avatar === undefined) row.avatar = '';
    }
    if (table === 'friendships') {
      if (row.status === undefined) row.status = 'pending';
      if (row.message === undefined) row.message = '';
    }
    data[table].push(row);
    save();
    return { lastInsertRowid: row.id, changes: 1 };
  }

  // SELECT ... FROM table WHERE ...
  if ((m = upper.match(/^SELECT (.+?) FROM (\w+)( WHERE (.+?))?( ORDER BY .+?)?( LIMIT \d+)?$/))) {
    const table = m[2].toLowerCase();
    const whereClause = m[4];
    let rows = data[table].slice();

    if (whereClause) {
      rows = rows.filter(row => matchWhere(whereClause, params, row, sql));
    }

    // 澶勭悊 JOIN锛堝ソ鍙嬪垪琛ㄦ煡璇級
    if (upper.includes(' JOIN ')) {
      return execFriendJoin(sql, params);
    }

    // 瀛楁閫夋嫨
    const fields = m[1].trim();
    if (fields !== '*') {
      rows = rows.map(r => {
        const out = {};
        fields.split(',').forEach(f => {
          const key = f.trim();
          if (r.hasOwnProperty(key)) out[key] = r[key];
        });
        return out;
      });
    }

    if (isGet) return rows[0];
    return rows;
  }

  // UPDATE table SET ... WHERE ...
  if ((m = upper.match(/^UPDATE (\w+) SET (.+?) WHERE (.+)$/))) {
    const table = m[1].toLowerCase();
    const setClause = m[2];
    const whereClause = m[3];
    let changes = 0;
    data[table].forEach(row => {
      if (matchWhere(whereClause, params, row, sql)) {
        setClause.split(',').forEach(assign => {
          const [col, val] = assign.split('=').map(x => x.trim());
          // 浠庡師濮� sql 涓彁鍙栧€�
          const origMatch = sql.match(new RegExp(col + '\\s*=\\s*\\?', 'i'));
          if (origMatch) {
            const idx = findParamIndex(sql, col);
            row[col] = params[idx];
          } else {
            row[col] = val.replace(/'/g, '');
          }
        });
        changes++;
      }
    });
    save();
    return { changes };
  }

  // DELETE FROM table WHERE ...
  if ((m = upper.match(/^DELETE FROM (\w+) WHERE (.+)$/))) {
    const table = m[1].toLowerCase();
    const whereClause = m[2];
    const before = data[table].length;
    data[table] = data[table].filter(row => !matchWhere(whereClause, params, row, sql));
    const changes = before - data[table].length;
    save();
    return { changes };
  }

  // CREATE TABLE - 蹇界暐锛屾暟鎹粨鏋勫浐瀹�
  if (upper.startsWith('CREATE TABLE')) {
    return { changes: 0 };
  }

  console.error('[DB] 涓嶆敮鎸佺殑 SQL:', sql);
  return isGet ? undefined : [];
}

// 鍖归厤 WHERE 鏉′欢锛堟敮鎸� AND, OR, =, !=, IN, 鎷彿锛�
function matchWhere(whereClause, params, row, fullSql) {
  let wc = whereClause.trim();
  // 鍘绘帀鏈熬鐨� ORDER BY / LIMIT
  wc = wc.replace(/\s+ORDER BY.+$/i, '').replace(/\s+LIMIT\s+\d+$/i, '');

  // 澶勭悊 OR
  if (wc.includes(' OR ')) {
    return wc.split(/\s+OR\s+/i).some(part => matchCondition(part.trim(), params, row));
  }
  // 澶勭悊 AND
  if (wc.includes(' AND ')) {
    return wc.split(/\s+AND\s+/i).every(part => matchCondition(part.trim(), params, row));
  }
  return matchCondition(wc, params, row);
}

let paramCounter = 0;
function matchCondition(cond, params, row) {
  cond = cond.trim().replace(/^\(|\)$/g, '');

  // col = ?
  let m;
  if ((m = cond.match(/^(\w+)\s*=\s*\?$/))) {
    return row[m[1]] === params[paramCounter++];
  }
  if ((m = cond.match(/^(\w+)\s*=\s*'([^']*)'$/))) {
    return row[m[1]] === m[2];
  }
  if ((m = cond.match(/^(\w+)\s*!=\s*\?$/))) {
    return row[m[1]] !== params[paramCounter++];
  }
  // col IN (?, ?)
  if ((m = cond.match(/^(\w+)\s+IN\s*\(([^)]+)\)$/i))) {
    const col = m[1];
    const placeholders = m[2].split(',').length;
    const vals = [];
    for (let i = 0; i < placeholders; i++) vals.push(params[paramCounter++]);
    return vals.includes(row[col]);
  }
  // (col = ? AND col2 = ?) OR (col3 = ? AND col4 = ?)
  if (cond.includes('(') && cond.includes(')')) {
    const groups = cond.match(/\(([^)]+)\)/g);
    if (groups && cond.includes('OR')) {
      return groups.some(g => {
        const inner = g.replace(/^\(|\)$/g, '');
        const parts = inner.split(/\s+AND\s+/i);
        return parts.every(p => matchCondition(p, params, row));
      });
    }
    if (groups && cond.includes('AND')) {
      return groups.every(g => {
        const inner = g.replace(/^\(|\)$/g, '');
        const parts = inner.split(/\s+AND\s+/i);
        return parts.every(p => matchCondition(p, params, row));
      });
    }
  }
  // col = ? AND col2 = ? (without parens)
  if (cond.includes(' AND ')) {
    return cond.split(/\s+AND\s+/i).every(p => matchCondition(p, params, row));
  }

  return false;
}

// 鎵惧埌 SET 瀛愬彞涓煇鍒楀搴旂殑鍙傛暟绱㈠紩
function findParamIndex(sql, col) {
  const before = sql.substring(0, sql.toLowerCase().indexOf('set ' + col.toLowerCase()));
  return (before.match(/\?/g) || []).length;
}

// 澶勭悊濂藉弸鍒楄〃鐨� JOIN 鏌ヨ
function execFriendJoin(sql, params) {
  // 杩欎釜鏌ヨ姣旇緝鐗规畩锛岀洿鎺ョ敤 JS 瀹炵幇
  const userId = params[0];
  const friendships = data.friendships.filter(f =>
    f.status === 'accepted' && (f.user_id === userId || f.friend_id === userId)
  );
  return friendships.map(f => {
    const friendId = f.user_id === userId ? f.friend_id : f.user_id;
    const u = data.users.find(u => u.id === friendId);
    if (!u) return null;
    return {
      id: u.id,
      nickname: u.nickname,
      avatar: u.avatar || '',
      friend_user_id: friendId
    };
  }).filter(Boolean);
}

// 鍖呰鎴� better-sqlite3 椋庢牸 API
function prepare(sql) {
  return {
    get: function(...args) {
      paramCounter = 0;
      return execSQL(sql, args, true);
    },
    all: function(...args) {
      paramCounter = 0;
      return execSQL(sql, args, false);
    },
    run: function(...args) {
      paramCounter = 0;
      return execSQL(sql, args, false);
    }
  };
}

function exec(sql) {
  // 寤鸿〃璇彞绛夛紝蹇界暐
  if (sql.trim().toUpperCase().startsWith('CREATE TABLE')) {
    return;
  }
}

function pragma() {}

console.log('[Database] JSON 鏁版嵁搴撳垵濮嬪寲瀹屾垚锛岃矾寰�:', dbPath);

module.exports = { prepare, exec, pragma };
