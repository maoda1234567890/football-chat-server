const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

// 引入数据库
const db = require('./database');

const app = express();
const server = http.createServer(app);

// 中间件
app.use(cors());
app.use(express.json());

// Socket.IO 配置
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// 内存中存储在线用户信息
const onlineUsers = new Map(); // socketId -> { userId, username, nickname }

// ============================================================
// HTTP API 路由
// ============================================================

// POST /api/register - HTTP 注册接口
app.post('/api/register', (req, res) => {
  try {
    const { username, password, nickname } = req.body;

    if (!username || !password || !nickname) {
      return res.status(400).json({ error: '用户名、密码和昵称不能为空' });
    }

    // 检查用户名是否已存在
    const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existingUser) {
      return res.status(409).json({ error: '用户名已存在' });
    }

    // 检查昵称是否已存在
    const existingNickname = db.prepare('SELECT id FROM users WHERE nickname = ?').get(nickname);
    if (existingNickname) {
      return res.status(409).json({ error: '昵称已存在' });
    }

    const result = db.prepare(
      'INSERT INTO users (username, password, nickname) VALUES (?, ?, ?)'
    ).run(username, password, nickname);

    res.status(201).json({
      message: '注册成功',
      userId: result.lastInsertRowid,
      username,
      nickname
    });
  } catch (error) {
    console.error('[API] 注册失败:', error.message);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// POST /api/login - HTTP 登录接口
app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }

    const user = db.prepare('SELECT id, username, nickname, avatar FROM users WHERE username = ? AND password = ?').get(username, password);

    if (!user) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    res.json({
      message: '登录成功',
      userId: user.id,
      username: user.username,
      nickname: user.nickname,
      avatar: user.avatar
    });
  } catch (error) {
    console.error('[API] 登录失败:', error.message);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// GET /api/user/:id - 获取用户信息
app.get('/api/user/:id', (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    if (isNaN(userId)) {
      return res.status(400).json({ error: '无效的用户ID' });
    }

    const user = db.prepare('SELECT id, username, nickname, avatar, created_at FROM users WHERE id = ?').get(userId);

    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    res.json(user);
  } catch (error) {
    console.error('[API] 获取用户信息失败:', error.message);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// ============================================================
// Socket.IO 事件处理
// ============================================================

io.on('connection', (socket) => {
  console.log(`[Socket] 新连接: ${socket.id}`);

  // --------------------------------------------------------
  // 1. 用户认证
  // --------------------------------------------------------

  // 注册
  socket.on('register', ({ username, password, nickname }) => {
    try {
      if (!username || !password || !nickname) {
        socket.emit('auth_error', { message: '用户名、密码和昵称不能为空' });
        return;
      }

      // 检查用户名是否已存在
      const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (existingUser) {
        socket.emit('auth_error', { message: '用户名已存在' });
        return;
      }

      // 检查昵称是否已存在
      const existingNickname = db.prepare('SELECT id FROM users WHERE nickname = ?').get(nickname);
      if (existingNickname) {
        socket.emit('auth_error', { message: '昵称已存在' });
        return;
      }

      const result = db.prepare(
        'INSERT INTO users (username, password, nickname) VALUES (?, ?, ?)'
      ).run(username, password, nickname);

      const userId = result.lastInsertRowid;

      // 记录在线状态
      onlineUsers.set(socket.id, { userId, username, nickname });

      socket.emit('auth_success', { userId, username, nickname });

      // 通知其他用户有新用户上线
      socket.broadcast.emit('user_online', { userId, nickname });
      io.emit('online_users', getOnlineUsersList());

      console.log(`[Socket] 用户注册并登录: ${username} (${socket.id})`);
    } catch (error) {
      console.error('[Socket] 注册失败:', error.message);
      socket.emit('auth_error', { message: '注册失败，请稍后重试' });
    }
  });

  // 登录
  socket.on('login', ({ username, password }) => {
    try {
      if (!username || !password) {
        socket.emit('auth_error', { message: '用户名和密码不能为空' });
        return;
      }

      const user = db.prepare('SELECT id, username, nickname, avatar FROM users WHERE username = ? AND password = ?').get(username, password);

      if (!user) {
        socket.emit('auth_error', { message: '用户名或密码错误' });
        return;
      }

      // 记录在线状态
      onlineUsers.set(socket.id, { userId: user.id, username: user.username, nickname: user.nickname });

      socket.emit('auth_success', { userId: user.id, username: user.username, nickname: user.nickname });

      // 通知其他用户
      socket.broadcast.emit('user_online', { userId: user.id, nickname: user.nickname });
      io.emit('online_users', getOnlineUsersList());

      console.log(`[Socket] 用户登录: ${user.username} (${socket.id})`);
    } catch (error) {
      console.error('[Socket] 登录失败:', error.message);
      socket.emit('auth_error', { message: '登录失败，请稍后重试' });
    }
  });

  // --------------------------------------------------------
  // 2. 聊天系统
  // --------------------------------------------------------

  // 发送世界聊天
  socket.on('send_world_message', ({ content }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) {
      socket.emit('auth_error', { message: '请先登录' });
      return;
    }

    if (!content || !content.trim()) {
      return;
    }

    const timestamp = new Date().toISOString();
    const messageData = {
      senderId: user.userId,
      senderName: user.nickname,
      content: content.trim(),
      timestamp
    };

    // 保存到数据库（receiver_id 为 null 表示世界聊天）
    db.prepare(
      'INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)'
    ).run(user.userId, null, content.trim());

    // 广播给所有在线用户
    io.emit('receive_world_message', messageData);

    console.log(`[Chat] 世界消息: ${user.nickname}: ${content.trim()}`);
  });

  // 发送私聊消息
  socket.on('send_private_message', ({ receiverId, content }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) {
      socket.emit('auth_error', { message: '请先登录' });
      return;
    }

    if (!receiverId || !content || !content.trim()) {
      return;
    }

    const timestamp = new Date().toISOString();
    const messageData = {
      senderId: user.userId,
      senderName: user.nickname,
      content: content.trim(),
      timestamp
    };

    // 保存到数据库
    db.prepare(
      'INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)'
    ).run(user.userId, receiverId, content.trim());

    // 发送给接收者
    for (const [sid, userInfo] of onlineUsers.entries()) {
      if (userInfo.userId === receiverId) {
        io.to(sid).emit('receive_private_message', messageData);
        break;
      }
    }

    // 也发回给发送者确认
    socket.emit('receive_private_message', messageData);

    console.log(`[Chat] 私聊: ${user.nickname} -> ${receiverId}: ${content.trim()}`);
  });

  // --------------------------------------------------------
  // 3. 好友系统
  // --------------------------------------------------------

  // 搜索用户
  socket.on('search_user', ({ nickname }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) {
      socket.emit('auth_error', { message: '请先登录' });
      return;
    }

    if (!nickname || !nickname.trim()) {
      socket.emit('user_not_found');
      return;
    }

    const foundUser = db.prepare(
      'SELECT id, nickname, avatar FROM users WHERE nickname = ? AND id != ?'
    ).get(nickname.trim(), user.userId);

    if (foundUser) {
      socket.emit('user_found', {
        userId: foundUser.id,
        nickname: foundUser.nickname,
        avatar: foundUser.avatar || ''
      });
    } else {
      socket.emit('user_not_found');
    }
  });

  // 发送好友请求
  socket.on('send_friend_request', ({ targetUserId, message }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) {
      socket.emit('auth_error', { message: '请先登录' });
      return;
    }

    if (!targetUserId) {
      return;
    }

    // 不能添加自己为好友
    if (targetUserId === user.userId) {
      socket.emit('friend_request_rejected', { userId: targetUserId, error: '不能添加自己为好友' });
      return;
    }

    // 检查是否已经是好友
    const existingFriend = db.prepare(
      "SELECT id FROM friendships WHERE ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)) AND status = 'accepted'"
    ).get(user.userId, targetUserId, targetUserId, user.userId);

    if (existingFriend) {
      socket.emit('auth_error', { message: '你们已经是好友了' });
      return;
    }

    // 检查是否已经有待处理的请求
    const existingRequest = db.prepare(
      "SELECT id FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 'pending'"
    ).get(user.userId, targetUserId);

    if (existingRequest) {
      socket.emit('auth_error', { message: '已经发送过好友请求，请等待对方处理' });
      return;
    }

    // 获取目标用户昵称
    const targetUser = db.prepare('SELECT nickname FROM users WHERE id = ?').get(targetUserId);
    if (!targetUser) {
      socket.emit('user_not_found');
      return;
    }

    // 创建好友请求
    const result = db.prepare(
      'INSERT INTO friendships (user_id, friend_id, status, message) VALUES (?, ?, ?, ?)'
    ).run(user.userId, targetUserId, 'pending', message || '');

    const requestId = result.lastInsertRowid;

    // 发送给目标用户
    for (const [sid, userInfo] of onlineUsers.entries()) {
      if (userInfo.userId === targetUserId) {
        io.to(sid).emit('receive_friend_request', {
          fromUserId: user.userId,
          fromNickname: user.nickname,
          message: message || '',
          requestId
        });
        break;
      }
    }

    socket.emit('friend_request_sent', { requestId, toNickname: targetUser.nickname });
    console.log(`[Friend] ${user.nickname} -> ${targetUser.nickname} 发送好友请求`);
  });

  // 接受好友请求
  socket.on('accept_friend', ({ requestId }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) {
      socket.emit('auth_error', { message: '请先登录' });
      return;
    }

    // 获取请求信息
    const request = db.prepare('SELECT * FROM friendships WHERE id = ? AND friend_id = ? AND status = ?').get(requestId, user.userId, 'pending');

    if (!request) {
      socket.emit('auth_error', { message: '好友请求不存在或已处理' });
      return;
    }

    // 更新状态为已接受
    db.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").run(requestId);

    // 获取请求方信息
    const requester = db.prepare('SELECT id, nickname, avatar FROM users WHERE id = ?').get(request.user_id);

    if (requester) {
      // 通知请求方：请求被接受
      for (const [sid, userInfo] of onlineUsers.entries()) {
        if (userInfo.userId === requester.id) {
          io.to(sid).emit('friend_request_accepted', {
            userId: user.userId,
            nickname: user.nickname
          });
          break;
        }
      }

      // 也通知接受方
      socket.emit('friend_request_accepted', {
        userId: requester.id,
        nickname: requester.nickname
      });

      console.log(`[Friend] ${user.nickname} 接受了 ${requester.nickname} 的好友请求`);
    }
  });

  // 拒绝好友请求
  socket.on('reject_friend', ({ requestId }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) {
      socket.emit('auth_error', { message: '请先登录' });
      return;
    }

    // 获取请求信息
    const request = db.prepare('SELECT * FROM friendships WHERE id = ? AND friend_id = ? AND status = ?').get(requestId, user.userId, 'pending');

    if (!request) {
      socket.emit('auth_error', { message: '好友请求不存在或已处理' });
      return;
    }

    // 删除请求记录
    db.prepare('DELETE FROM friendships WHERE id = ?').run(requestId);

    // 通知请求方：请求被拒绝
    for (const [sid, userInfo] of onlineUsers.entries()) {
      if (userInfo.userId === request.user_id) {
        io.to(sid).emit('friend_request_rejected', { userId: user.userId });
        break;
      }
    }

    socket.emit('friend_request_rejected', { userId: request.user_id });
    console.log(`[Friend] ${user.nickname} 拒绝了来自 ${request.user_id} 的好友请求`);
  });

  // 获取好友列表
  socket.on('get_friends_list', () => {
    const user = onlineUsers.get(socket.id);
    if (!user) {
      socket.emit('auth_error', { message: '请先登录' });
      return;
    }

    // 查询所有已接受的好友关系
    const friendships = db.prepare(`
      SELECT u.id, u.nickname, u.avatar,
        CASE
          WHEN f.user_id = ? THEN f.friend_id
          ELSE f.user_id
        END as friend_user_id
      FROM friendships f
      JOIN users u ON u.id = CASE
        WHEN f.user_id = ? THEN f.friend_id
        ELSE f.user_id
      END
      WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted'
    `).all(user.userId, user.userId, user.userId, user.userId);

    const friendsList = friendships.map(f => ({
      userId: f.friend_user_id,
      nickname: f.nickname,
      avatar: f.avatar || '',
      online: isUserOnline(f.friend_user_id)
    }));

    socket.emit('friends_list', friendsList);
  });

  // 删除好友
  socket.on('remove_friend', ({ friendId }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) {
      socket.emit('auth_error', { message: '请先登录' });
      return;
    }

    if (!friendId) {
      return;
    }

    // 删除双向好友关系
    db.prepare(
      "DELETE FROM friendships WHERE ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)) AND status = 'accepted'"
    ).run(user.userId, friendId, friendId, user.userId);

    socket.emit('friend_removed', { friendId });

    // 通知对方
    for (const [sid, userInfo] of onlineUsers.entries()) {
      if (userInfo.userId === friendId) {
        io.to(sid).emit('friend_removed', { friendId: user.userId });
        break;
      }
    }

    console.log(`[Friend] ${user.nickname} 删除了好友 ${friendId}`);
  });

  // --------------------------------------------------------
  // 4. 断线处理
  // --------------------------------------------------------

  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    if (user) {
      onlineUsers.delete(socket.id);

      // 广播用户下线
      socket.broadcast.emit('user_offline', { userId: user.userId });
      io.emit('online_users', getOnlineUsersList());

      console.log(`[Socket] 用户下线: ${user.nickname} (${socket.id})`);
    } else {
      console.log(`[Socket] 连接断开: ${socket.id}`);
    }
  });
});

// ============================================================
// 辅助函数
// ============================================================

// 获取在线用户列表
function getOnlineUsersList() {
  const list = [];
  for (const [, userInfo] of onlineUsers.entries()) {
    list.push({ userId: userInfo.userId, nickname: userInfo.nickname });
  }
  return list;
}

// 检查用户是否在线
function isUserOnline(userId) {
  for (const [, userInfo] of onlineUsers.entries()) {
    if (userInfo.userId === userId) {
      return true;
    }
  }
  return false;
}

// ============================================================
// 启动服务器
// ============================================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log('  Football Chat Server');
  console.log(`  运行在端口: ${PORT}`);
  console.log(`  数据库路径: ${path.join(__dirname, 'data', 'database.db')}`);
  console.log('='.repeat(50));
});
