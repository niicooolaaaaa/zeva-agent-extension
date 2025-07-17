import { Octokit } from "@octokit/core";
import express from "express";
import { Readable } from "node:stream";
import fs from "fs";
import path from "path";
import cookieParser from "cookie-parser";
import fetch from "node-fetch";

// Load environment variables
const {
  CLIENT_ID,
  CLIENT_SECRET,
  FQDN,
  PROJECT_CONTEXT,
  PROJECT_CONTEXT_PATH,
  DEFAULT_MODEL = 'gpt-4',
  PORT = 3000
} = process.env;

if (!CLIENT_ID || !CLIENT_SECRET || !FQDN) {
  console.error("Missing required env vars: CLIENT_ID, CLIENT_SECRET, or FQDN");
  process.exit(1);
}

// Load project context
function loadProjectContext() {
  if (PROJECT_CONTEXT) return PROJECT_CONTEXT;
  if (PROJECT_CONTEXT_PATH && fs.existsSync(PROJECT_CONTEXT_PATH)) {
    return fs.readFileSync(path.resolve(PROJECT_CONTEXT_PATH), "utf8");
  }
  return `Project "Apollo"
• Stack: Go, PostgreSQL, Redis
• Domain: payments processing
• Goal: 99.9% uptime and sub-second latency`;
}
const CONTEXT = loadProjectContext();

const app = express();
app.use(express.json());
app.use(cookieParser());

// OAuth: redirect users to GitHub to authenticate
app.get('/auth/authorization', (req, res) => {
  const state = Math.random().toString(36).substring(2, 15);
  res.cookie('oauth_state', state, { httpOnly: true, sameSite: 'lax' });
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: `${FQDN}/auth/callback`,
    state,
    scope: 'repo'
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// OAuth callback: exchange code for access token
app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  const savedState = req.cookies['oauth_state'];
  if (!code || !state || state !== savedState) {
    return res.status(400).send('Invalid OAuth state or missing code');
  }

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Accept': 'application/json' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: code.toString(),
        redirect_uri: `${FQDN}/auth/callback`,
        state: state.toString()
      })
    });
    const { access_token, error } = await tokenRes.json();
    if (error || !access_token) throw new Error(error || 'No access token');
    res.cookie('github_token', access_token, { httpOnly: true, sameSite: 'lax' });
    res.redirect('/');
  } catch (err) {
    console.error('OAuth token exchange failed', err);
    res.status(500).send('Authentication failed');
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('Welcome! To start, authenticate at /auth/authorization');
});

// Agent endpoint: proxy to Copilot with injected context and dynamic model
app.post('/agent', async (req, res) => {
  const token = req.cookies['github_token'] || req.get('X-GitHub-Token');
  if (!token) {
    return res.status(401).send('Unauthorized: missing GitHub token. Please authenticate at /auth/authorization');
  }

  // Identify user
  let login;
  try {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.request('GET /user');
    login = data.login;
    console.log(`User: @${login}`);
  } catch (err) {
    console.error('Invalid GitHub token', err);
    return res.status(401).send('Invalid GitHub token');
  }

  // Extract messages and config from payload
  const { messages, model: bodyModel, config } = req.body;
  if (!Array.isArray(messages)) {
    return res.status(400).send('Invalid payload: messages array missing');
  }

  // Determine which model to use: prioritize body.model, then config.model, then default
  const selectedModel = bodyModel?.trim() || config?.model?.trim() || DEFAULT_MODEL;

  // Prepare system prompts
  const systemPrompts = [
    { role: 'system', content: `Start every response with: @${login}` },
    { role: 'system', content: 'You are an expert assistant specializing in distributed systems and payments processing.' },
    { role: 'system', content: `Project-specific context:\n${CONTEXT.trim()}` }
  ];

  // Build outbound request preserving all client-provided fields, but override messages, model, and stream
  const outbound = {
    ...req.body,
    model: selectedModel,
    stream: true,
    messages: [...systemPrompts, ...messages]
  };

  // Proxy to Copilot Chat API
  try {
    const apiRes = await fetch('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(outbound)
    });

    // Stream SSE
    res.writeHead(apiRes.status, {
      'Content-Type': 'text/event-stream',
      ...Object.fromEntries(apiRes.headers)
    });
    Readable.from(apiRes.body).pipe(res);
  } catch (err) {
    console.error('Error proxying to Copilot API', err);
    res.status(500).send('Internal server error');
  }
});

app.post('/query', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body;

  console.log(req.body)

  // --- 1) Handshake
  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: {
          resources:    { listChanged: false, subscribe: false },
          prompts:      { listChanged: false },
          tools:        { listChanged: false },
          logging:      {}
        },
        serverInfo: { name: 'zeva-mcp-server', version: '1.0.0' }
      }
    });
  }
  if (method === 'notifications/initialized') {
    return res.status(204).end();
  }

  // --- 2) Tool discovery
  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            id: 'retrieve',
            name: 'Context Retrieval',
            description: 'Fetch relevant context snippets for the user’s query',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'User question to retrieve context for' }
              },
              required: ['query']
            }
          }
        ]
      }
    });
  }

  // --- 3) The actual retrieve call
  if (method === 'retrieve') {
    const docs = await retrieveFromYourIndex(params.query);
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        documents: docs.map((d,i) => ({
          id:       d.id   ?? `${i}`,
          cursor:   d.cursor ?? `${i}`,
          text:     d.text,
          metadata: d.metadata ?? {}
        }))
      }
    });
  }

  // --- 4) Unknown method
  return res.json({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` }
  });
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
