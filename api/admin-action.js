export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });

  const { password, action, userId, memoryId, newContent, reason, durationHours, limit } = await req.json();
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

  if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const headers = {
    'apikey': SECRET_KEY,
    'Authorization': `Bearer ${SECRET_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  };

  try {
    // 1. PERMANENT BAN
    if (action === 'ban_permanent') {
      await fetch(`${SUPABASE_URL}/rest/v1/blocked_users?user_id=eq.${userId}`, { method: 'DELETE', headers });
      await fetch(`${SUPABASE_URL}/rest/v1/blocked_users`, {
        method: 'POST', headers,
        body: JSON.stringify({ user_id: userId, ban_type: 'permanent', reason: reason || 'Violated Rules' })
      });
      return new Response(JSON.stringify({ success: true, msg: 'User Permanently Banned' }), { status: 200 });
    }

    // 2. TEMPORARY BAN
    if (action === 'ban_temporary') {
      const expiresAt = new Date(Date.now() + (durationHours || 24) * 60 * 60 * 1000).toISOString();
      await fetch(`${SUPABASE_URL}/rest/v1/blocked_users?user_id=eq.${userId}`, { method: 'DELETE', headers });
      await fetch(`${SUPABASE_URL}/rest/v1/blocked_users`, {
        method: 'POST', headers,
        body: JSON.stringify({ user_id: userId, ban_type: 'temporary', reason: reason || 'Cool down', expires_at: expiresAt })
      });
      return new Response(JSON.stringify({ success: true, msg: `User Banned for ${durationHours} Hours` }), { status: 200 });
    }

    // 3. UNBAN
    if (action === 'unban') {
      await fetch(`${SUPABASE_URL}/rest/v1/blocked_users?user_id=eq.${userId}`, { method: 'DELETE', headers });
      return new Response(JSON.stringify({ success: true, msg: 'User Unbanned' }), { status: 200 });
    }

    // 4. SET LIMITS
    if (action === 'set_limit') {
      const checkRes = await fetch(`${SUPABASE_URL}/rest/v1/user_limits?user_id=eq.${userId}`, { headers });
      const existing = await checkRes.json();
      
      if (existing.length > 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/user_limits?user_id=eq.${userId}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ daily_limit: parseInt(limit) })
        });
      } else {
        await fetch(`${SUPABASE_URL}/rest/v1/user_limits`, {
          method: 'POST', headers,
          body: JSON.stringify({ user_id: userId, daily_limit: parseInt(limit) })
        });
      }
      return new Response(JSON.stringify({ success: true, msg: `Limit set to ${limit}` }), { status: 200 });
    }

    // 5. DELETE MEMORY
    if (action === 'delete_memory') {
      await fetch(`${SUPABASE_URL}/rest/v1/memories?id=eq.${memoryId}`, { method: 'DELETE', headers });
      return new Response(JSON.stringify({ success: true, msg: 'Memory Deleted from AI' }), { status: 200 });
    }

    // 6. UPDATE MEMORY
    if (action === 'update_memory') {
      await fetch(`${SUPABASE_URL}/rest/v1/memories?id=eq.${memoryId}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ content: newContent })
      });
      return new Response(JSON.stringify({ success: true, msg: 'Memory Updated' }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400 });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}