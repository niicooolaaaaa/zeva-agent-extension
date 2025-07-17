import { Octokit } from "@octokit/core";
import express from "express";
import { Readable } from "node:stream";
import fs from "fs";
import path from "path";

const app = express();

// Load project context from environment or optional markdown file
const PROJECT_CONTEXT = process.env.PROJECT_CONTEXT || (() => {
  const ctxPath = process.env.PROJECT_CONTEXT_PATH;
  if (ctxPath && fs.existsSync(ctxPath)) {
    return fs.readFileSync(path.resolve(ctxPath), "utf8");
  }
  // Fallback default context
  return `Project "Apollo"
• Stack: Go, PostgreSQL, Redis
• Domain: payments processing
• Goal: 99.9% uptime and sub-second latency`;
})();

app.get("/", (req, res) => {
  res.send("Welcome to your custom Copilot Extension with project context!");
});

app.post("/", express.json(), async (req, res) => {
  const token = req.get("X-GitHub-Token");
  if (!token) {
    return res.status(401).send("Missing GitHub token header");
  }

  // Identify the user via GitHub API
  let login;
  try {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.request("GET /user");
    login = data.login;
    console.log(`User: @${login}`);
  } catch (err) {
    console.error("Invalid token or GitHub API error", err);
    return res.status(401).send("Invalid GitHub token");
  }

  // Prepare custom system prompts
  const systemPrompts = [
    {
      role: "system",
      content: `Start every response with the user's handle: @${login}.`
    },
    {
      role: "system",
      content: "You are an expert assistant specializing in distributed systems and payments processing."
    },
    {
      role: "system",
      content: `Project-specific context:\n${PROJECT_CONTEXT.trim()}`
    }
  ];

  // Merge custom prompts with the incoming messages
  const inbound = req.body;
  if (!Array.isArray(inbound.messages)) {
    return res.status(400).send("Invalid payload: messages array missing");
  }

  const outbound = {
    stream: true,
    messages: [
      ...systemPrompts,
      ...inbound.messages
    ]
  };

  // Proxy the request to GitHub Copilot Chat API
  const apiRes = await fetch(
    "https://api.githubcopilot.com/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(outbound)
    }
  );

  // Stream Copilot's SSE response back to the client
  res.writeHead(apiRes.status, {
    'Content-Type': 'text/event-stream',
    ...Object.fromEntries(apiRes.headers)
  });
  Readable.from(apiRes.body).pipe(res);
});

const port = Number(process.env.PORT || '3000');
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
