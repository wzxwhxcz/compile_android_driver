import { serve } from "https://deno.land/std@0.170.0/http/server.ts";


// 扩展 globalThis 类型
declare global {
  interface Window {
    emailId: string;
    currentEmail: string;
  }
  var emailId: string;
  var currentEmail: string;
}

const PORT = 8080;
const TEMP_MAIL_API_BASE = "https://moemail.wenwen12345.top/api";
const TEMP_MAIL_API_KEY = "mk_nVhgA-xCiBvVET50Sx-JF9Dv-XeUikRz";

// Tetrate AI 相关常量 - 直接访问，不使用代理
const TETRATE_AUTH_BASE = `https://auth.tetrate.ai`;
const TETRATE_ROUTER_BASE = `https://router.tetrate.ai`;
const TETRATE_CALLBACK_URL = `https://router.tetrate.ai/dashboard?new-user=true`;

/* ---------- Next Action 可配置（手工修改处） ---------- */
// 将 next-action 放在文件前面，便于人工更新。若你已在浏览器开发者工具中抓到最新的 Action ID，
// 直接修改以下常量即可生效。
const NEXT_ACTION = {
  // Dashboard 预加载使用，用于提取余额等信息
  DASHBOARD: "7fce3445e7dffea90d07f76aa9fca625033a40384e",
  // 创建 API Key 的 Server Action（常变动）。请填写你抓到的最新 ID。
  // 留空则尝试从页面 HTML 中自动提取；若仍无法提取，将报错提示你在此处填写。
  CREATE_API_KEY_MANUAL: " 7fce3445e7dffea90d07f76aa9fca625033a40384e"
} as const;

/* ---------- 进度管理 ---------- */
interface ProgressStep {
  status: string;
  message: string;
}

interface RegistrationProgress {
  steps: Record<string, ProgressStep>;
  lastUpdate: number;
  isRunning: boolean;
}

const registrationProgress: RegistrationProgress = {
  steps: {},
  lastUpdate: Date.now(),
  isRunning: false,
};

function updateProgress(stepNum: number, status: string, message: string) {
  registrationProgress.steps[stepNum] = { status, message };
  registrationProgress.lastUpdate = Date.now();
  for (let i = 1; i < stepNum; i++) {
    if (registrationProgress.steps[i]?.status !== 'error') {
      registrationProgress.steps[i].status = "completed";
    }
  }
}

/* ---------- 日志函数 ---------- */
function log(type: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    type,
    ...data,
  }));
}

function enhancedLog(type: string, data: Record<string, unknown>) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    type,
    ...data,
  };
  
  // 详细的控制台输出
  console.log(`[${logEntry.timestamp}] ${type}:`, JSON.stringify(data, null, 2));

  if (type === "AUTO_REGISTER_STEP" || type === "GET_REG_LINK_STEP") {
    const step = data.step as number;
    const message = data.message as string;
    updateProgress(step, "active", message);
  } else if (type === "AUTO_REGISTER_ERROR" || type === "GET_REG_LINK_ERROR") {
    Object.keys(registrationProgress.steps).forEach((stepNum) => {
      const step = registrationProgress.steps[stepNum];
      if (step.status === "active") {
        step.status = "error";
      }
    });
  }
}

// @ts-ignore
globalThis.log = enhancedLog;

/* ---------- 工具函数 ---------- */
async function parseSafeJson(resp: Response): Promise<unknown> {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`无效的JSON (${resp.status}): ${text.slice(0, 200)}`);
  }
}

function generateRandomString(length = 8): string {
  return Math.random().toString(36).substring(2, 2 + length);
}

function generatePassword(length = 16): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%";
  let password = "";
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

/* ---------- 临时邮箱 API (使用 moemail.wenwen12345.top) ---------- */
interface EmailGenerateResponse {
  id: string;
  email: string;
  name?: string;
  domain?: string;
  expiryTime?: number;
  createdAt?: string;
}

interface Mail {
  id: string;
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  date: string;
  attachments?: any[];
}

// 创建临时邮箱
async function createTempEmail(): Promise<string> {
  try {
    enhancedLog("TEMP_EMAIL_REQUEST", { message: "开始创建临时邮箱..." });
    
    const domain = "wencursor.dpdns.org";
    const requestBody = {
      name: "tetrate_" + Math.random().toString(36).substring(2, 8),
      expiryTime: 3600000,
      domain: domain
    };
    
    const headers = {
      "X-API-Key": TEMP_MAIL_API_KEY,
      "Content-Type": "application/json"
    };
    
    const response = await fetch(`${TEMP_MAIL_API_BASE}/emails/generate`, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(requestBody)
    });

    enhancedLog("TEMP_EMAIL_RESPONSE", {
      status: response.status,
      statusText: response.statusText
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json() as EmailGenerateResponse;
    
    if (!data.id || !data.email) {
      throw new Error("创建邮箱失败：响应缺少必要字段");
    }

    globalThis.emailId = data.id;
    globalThis.currentEmail = data.email;
    
    enhancedLog("TEMP_EMAIL_CREATED", {
      email: data.email,
      emailId: data.id
    });
    
    return data.email;
  } catch (error) {
    enhancedLog("TEMP_EMAIL_ERROR", {
      message: String(error),
      stack: (error as Error).stack
    });
    throw error;
  }
}

// 获取邮件列表
async function getMailbox(): Promise<Mail[]> {
  try {
    if (!globalThis.emailId) {
      throw new Error("邮箱ID未找到");
    }

    const headers = {
      "X-API-Key": TEMP_MAIL_API_KEY,
      "Content-Type": "application/json"
    };

    const response = await fetch(`${TEMP_MAIL_API_BASE}/emails/${globalThis.emailId}`, {
      headers: headers
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    let emails: Mail[] = [];
    
    if (Array.isArray(data.messages)) {
      emails = data.messages.map((msg: any) => ({
        id: msg.id,
        from: msg.from_address || msg.from,
        to: globalThis.currentEmail,
        subject: msg.subject,
        text: msg.text || "",
        html: msg.html || "",
        date: msg.received_at ? new Date(msg.received_at).toISOString() : new Date().toISOString(),
      }));
    }
    
    return emails;
  } catch (error) {
    enhancedLog("MAILBOX_ERROR", { message: String(error) });
    throw error;
  }
}

// 获取邮件详情
async function getEmailDetails(messageId: string): Promise<Mail> {
  try {
    if (!globalThis.emailId) {
      throw new Error("邮箱ID未找到");
    }

    const headers = {
      "X-API-Key": TEMP_MAIL_API_KEY,
      "Content-Type": "application/json"
    };

    const response = await fetch(`${TEMP_MAIL_API_BASE}/emails/${globalThis.emailId}/${messageId}`, {
      headers: headers
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    let mailDetails: Mail;
    
    if (data.message && data.message.id) {
      const msg = data.message;
      mailDetails = {
        id: msg.id,
        from: msg.from_address || msg.from,
        to: globalThis.currentEmail,
        subject: msg.subject,
        text: msg.content || msg.text || "",
        html: msg.html || msg.html_body || "",
        date: msg.received_at ? new Date(msg.received_at).toISOString() : new Date().toISOString(),
      };
    } else {
      throw new Error("未知的邮件详情响应格式");
    }
    
    return mailDetails;
  } catch (error) {
    enhancedLog("EMAIL_DETAILS_ERROR", { message: String(error) });
    throw error;
  }
}

/* ---------- Tetrate AI 注册 API ---------- */
async function registerWithTetrate(email: string, password: string, name: string) {
  const url = `${TETRATE_AUTH_BASE}/api/auth/sign-up/email`;
  const headers = {
    "accept": "*/*",
    "content-type": "application/json",
    "origin": TETRATE_ROUTER_BASE,
    "referer": `${TETRATE_ROUTER_BASE}/`,
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
  };
  const body = JSON.stringify({
    email: email,
    password: password,
    name: name,
    callbackURL: TETRATE_CALLBACK_URL,
    role: "user",
    banned: false,
    banReason: "",
    banExpires: "",
    phone: "",
    website: "",
    address: ""
  });

  try {
    enhancedLog("REGISTER_REQUEST", {
      url,
      email,
      name,
      bodyLength: body.length
    });
    
    const response = await fetch(url, {
      method: "POST",
      headers: headers,
      body: body,
    });
    
    enhancedLog("REGISTER_RESPONSE", {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries())
    });
    
    const responseData = await parseSafeJson(response);
    enhancedLog("REGISTER_SUCCESS", {
      status: response.status,
      data: responseData
    });
    return responseData;
  } catch (error) {
    enhancedLog("REGISTER_ERROR", {
      message: String(error),
      stack: (error as Error).stack
    });
    throw error;
  }
}

/* ---------- 获取注册链接（不自动注册）---------- */
async function getRegistrationLink() {
  try {
    enhancedLog("GET_REG_LINK_START", { message: "开始获取注册链接流程..." });
    
    // 步骤1: 创建临时邮箱
    const email = await createTempEmail();
    const password = generatePassword();
    const name = email.split('@')[0];
    enhancedLog("GET_REG_LINK_STEP", {
      step: 1,
      message: "临时邮箱创建成功",
      email,
      password,
      name
    });

    // 步骤2: 注册 Tetrate AI 账户
    const registerResponse = await registerWithTetrate(email, password, name);
    const userId = (registerResponse as any)?.user?.id;
    if (!userId) {
      throw new Error("注册响应中未找到用户ID");
    }
    enhancedLog("GET_REG_LINK_STEP", {
      step: 2,
      message: "Tetrate AI 注册成功",
      userId
    });

    // 步骤3: 等待并提取验证链接
    let verificationLink: string | null = null;
    let attempts = 0;
    const maxAttempts = 24; // 24次 * 5秒 = 2分钟
    
    while (!verificationLink && attempts < maxAttempts) {
      attempts++;
      enhancedLog("GET_REG_LINK_STEP", {
        step: 3,
        message: `等待验证邮件 (尝试 ${attempts}/${maxAttempts})`
      });
      
      await new Promise((resolve) => setTimeout(resolve, 5000));
      
      try {
        const messages = await getMailbox();
        enhancedLog("MAILBOX_CHECK", {
          attempt: attempts,
          messageCount: messages.length,
          messages: messages.map(m => ({
            from: m.from,
            subject: m.subject,
            date: m.date
          }))
        });
        
        for (const message of messages) {
          // 检查是否是 Tetrate 的验证邮件
          if (
            message.subject.toLowerCase().includes("verify") ||
            message.subject.toLowerCase().includes("verification") ||
            message.from.toLowerCase().includes("tetrate") ||
            message.from.toLowerCase().includes("noreply")
          ) {
            // 获取邮件详情
            const emailDetails = await getEmailDetails(message.id);
            const emailContent = emailDetails.html || emailDetails.text || "";
            
            enhancedLog("EMAIL_CONTENT_CHECK", {
              messageId: message.id,
              from: message.from,
              subject: message.subject,
              contentLength: emailContent.length,
              contentPreview: emailContent.substring(0, 200)
            });
            
            // 提取完整的验证链接
            const linkMatch = emailContent.match(/https:\/\/auth\.tetrate\.ai\/api\/auth\/verify-email\?token=[a-zA-Z0-9._-]+&callbackURL=[^"'\\s<>]+/);
            if (linkMatch) {
              verificationLink = linkMatch[0];
              enhancedLog("GET_REG_LINK_STEP", {
                step: 3,
                message: "验证链接已找到",
                link: verificationLink,
                from: message.from,
                subject: message.subject
              });
              break;
            }
          }
        }
        
        if (verificationLink) break;
      } catch (error) {
        enhancedLog("MAILBOX_CHECK_ERROR", {
          attempt: attempts,
          error: String(error),
          stack: (error as Error).stack
        });
      }
    }
    
    if (!verificationLink) {
      throw new Error(`未能找到验证链接（已尝试 ${maxAttempts} 次）`);
    }

    enhancedLog("GET_REG_LINK_SUCCESS", {
      message: "成功获取注册链接",
      link: verificationLink
    });

    return {
      status: "success",
      message: "成功获取注册链接",
      email,
      password,
      userId,
      verificationLink,
    };
  } catch (error) {
    enhancedLog("GET_REG_LINK_ERROR", {
      message: String(error),
      stack: (error as Error).stack
    });
    return {
      status: "error",
      message: String(error),
    };
  }
}

/* ---------- 辅助请求函数 ---------- */
// 发送Heap Analytics追踪
async function sendHeapAnalytics(eventType: string = "pageview"): Promise<void> {
  try {
    const url = "https://c.us.heap-api.com/api/capture/v2/track";
    // 这里简化处理,实际的protobuf数据比较复杂
    await fetch(url, {
      method: "POST",
      headers: {
        "accept": "*/*",
        "content-type": "application/octet-stream",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "cross-site"
      },
      body: new Uint8Array([]) // 简化的空body
    }).catch(() => {}); // 忽略错误
    
    enhancedLog("HEAP_ANALYTICS_SENT", { eventType });
  } catch (error) {
    // 静默失败,不影响主流程
  }
}

// 发送Reo.dev事件
async function sendReoEvent(sessionToken: string): Promise<void> {
  try {
    const url = "https://api.reo.dev/api/v1/ghost/event";
    await fetch(url, {
      method: "POST",
      headers: {
        "accept": "*/*",
        "content-type": "application/json",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "cross-site"
      },
      body: JSON.stringify({
        fid: Math.random().toString(36).substring(2),
        uid: Math.random().toString(36).substring(2, 9).toUpperCase(),
        eid: Date.now(),
        payload: JSON.stringify({
          tid: Math.random().toString(36).substring(2, 8),
          pageTitle: "Tetrate Agent Router Service",
          activity: "Page Load",
          timeSpent: 0
        })
      })
    }).catch(() => {}); // 忽略错误
    
    enhancedLog("REO_EVENT_SENT", { message: "Reo.dev事件已发送" });
  } catch (error) {
    // 静默失败
  }
}

// 获取公告信息
async function fetchAnnouncement(sessionToken: string): Promise<void> {
  try {
    const url = `${TETRATE_ROUTER_BASE}/api/announcement`;
    await fetch(url, {
      method: "GET",
      headers: {
        "accept": "application/json",
        "cookie": `__Secure-fraser.session_token=${sessionToken}`,
        "referer": TETRATE_CALLBACK_URL,
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin"
      }
    }).catch(() => {});
    
    enhancedLog("ANNOUNCEMENT_FETCHED", { message: "公告信息已获取" });
  } catch (error) {
    // 静默失败
  }
}

// 获取用户余额
async function fetchUserBalance(sessionToken: string): Promise<any> {
  try {
    const url = `${TETRATE_ROUTER_BASE}/api/user-balance`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "accept": "application/json",
        "cookie": `__Secure-fraser.session_token=${sessionToken}`,
        "referer": TETRATE_CALLBACK_URL,
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin"
      }
    });

    if (response.ok) {
      const balanceData = await response.json();
      enhancedLog("USER_BALANCE_FETCHED", {
        message: "用户余额信息已获取",
        balance: balanceData
      });
      return balanceData;
    }
    return null;
  } catch (error) {
    enhancedLog("USER_BALANCE_ERROR", {
      message: "获取余额失败",
      error: String(error)
    });
    return null;
  }
}

// 预加载dashboard页面并获取余额
async function preloadDashboard(sessionToken: string): Promise<any> {
  try {
    const url = `${TETRATE_ROUTER_BASE}/dashboard`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "accept": "text/x-component",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
        "content-type": "text/plain;charset=UTF-8",
        "cookie": `__Secure-fraser.session_token=${sessionToken}`,
        "next-action": NEXT_ACTION.DASHBOARD,
        "next-router-state-tree": "%5B%22%22%2C%7B%22children%22%3A%5B%22(dashboard)%22%2C%7B%22children%22%3A%5B%22dashboard%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%2Ctrue%5D",
        "priority": "u=1, i",
        "sec-ch-ua": '"Chromium";v="140", "Not=A?Brand";v="24", "Microsoft Edge";v="140"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "referer": TETRATE_CALLBACK_URL
      },
      body: "[]"
    });
    
    if (response.ok) {
      const text = await response.text();
      enhancedLog("DASHBOARD_PRELOADED", {
        message: "Dashboard页面已预加载",
        responsePreview: text.substring(0, 200)
      });
      
      // 解析余额信息 - 格式: 1:{"balance":5,"currency":"USD","lastUpdated":"..."}
      const balanceMatch = text.match(/\d+:\{"balance":(\d+(?:\.\d+)?),"currency":"([^"]+)","lastUpdated":"([^"]+)"\}/);
      if (balanceMatch) {
        const balanceInfo = {
          balance: parseFloat(balanceMatch[1]),
          currency: balanceMatch[2],
          lastUpdated: balanceMatch[3]
        };
        enhancedLog("BALANCE_EXTRACTED", {
          message: "从Dashboard响应中提取余额",
          balance: balanceInfo
        });
        return balanceInfo;
      }
    }
    
    return null;
  } catch (error) {
    enhancedLog("DASHBOARD_PRELOAD_ERROR", {
      message: "预加载Dashboard失败",
      error: String(error)
    });
    return null;
  }
}

/* ---------- 获取Session信息 ---------- */
async function getSessionInfo(sessionToken: string): Promise<any> {
  const url = `${TETRATE_AUTH_BASE}/api/auth/get-session`;
  
  // 设置cookies - 简化版本,只包含必要的session token
  const cookies = `__Secure-fraser.session_token=${sessionToken}`;

  const headers = {
    "accept": "*/*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
    "priority": "u=1, i",
    "referer": `${TETRATE_ROUTER_BASE}/`,
    "sec-ch-ua": '"Chromium";v="140", "Not=A?Brand";v="24", "Microsoft Edge";v="140"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
    "cookie": cookies
  };

  try {
    enhancedLog("GET_SESSION_REQUEST", {
      url,
      sessionTokenPreview: sessionToken.substring(0, 20) + "..."
    });

    const response = await fetch(url, {
      method: "GET",
      headers: headers
    });

    enhancedLog("GET_SESSION_RESPONSE", {
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type")
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    // 先获取文本,然后尝试解析
    const responseText = await response.text();
    
    // 尝试解析JSON
    let sessionData;
    try {
      sessionData = JSON.parse(responseText);
      enhancedLog("GET_SESSION_SUCCESS", {
        data: sessionData
      });
    } catch (parseError) {
      enhancedLog("GET_SESSION_PARSE_ERROR", {
        message: "无法解析响应为JSON,可能是压缩数据",
        parseError: String(parseError),
        responseLength: responseText.length,
        responsePreview: responseText.substring(0, 100),
        contentType: response.headers.get("content-type"),
        contentEncoding: response.headers.get("content-encoding")
      });
      // 返回原始文本而不是抛出错误
      sessionData = {
        raw: responseText,
        parsed: false,
        note: "响应可能是压缩数据,需要解压缩"
      };
    }

    return sessionData;
  } catch (error) {
    enhancedLog("GET_SESSION_ERROR", {
      message: String(error),
      stack: (error as Error).stack
    });
    throw error;
  }
}

async function verifyEmailWithToken(token: string, callbackURL: string): Promise<string> {
  const url = `${TETRATE_AUTH_BASE}/api/auth/verify-email?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent(callbackURL)}`;
  
  // 第一步: 访问验证链接(模拟浏览器点击邮件链接)
  const headers = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
    "priority": "u=0, i",
    "sec-ch-ua": '"Chromium";v="140", "Not=A?Brand";v="24", "Microsoft Edge";v="140"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0"
  };

  try {
    enhancedLog("VERIFY_EMAIL_STEP1", { message: "访问验证链接", url });
    
    const response = await fetch(url, {
      method: "GET",
      headers: headers,
      redirect: "manual" // 不自动跟随重定向
    });

    enhancedLog("VERIFY_EMAIL_RESPONSE", {
      status: response.status,
      statusText: response.statusText,
      location: response.headers.get("location")
    });

    const setCookie = response.headers.get("set-cookie");
    if (!setCookie) {
      throw new Error("未能获取 session cookie");
    }

    const sessionTokenMatch = setCookie.match(/__Secure-fraser\.session_token=([^;]+)/);
    if (!sessionTokenMatch) {
      throw new Error("未能从 Set-Cookie 中提取 session token");
    }

    const sessionToken = sessionTokenMatch[1];
    
    // 第二步: 跟随重定向到dashboard(模拟浏览器自动跳转)
    const redirectUrl = response.headers.get("location");
    if (redirectUrl) {
      enhancedLog("VERIFY_EMAIL_STEP2", { message: "跟随重定向", redirectUrl });
      
      await fetch(redirectUrl, {
        method: "GET",
        headers: {
          ...headers,
          "cookie": `__Secure-fraser.session_token=${sessionToken}`,
          "referer": url
        },
        redirect: "manual"
      }).catch(() => {}); // 忽略错误
    }
    
    log("VERIFY_EMAIL_SUCCESS", { sessionToken: sessionToken.substring(0, 20) + "..." });
    return sessionToken;
  } catch (error) {
    log("VERIFY_EMAIL_ERROR", { message: String(error) });
    throw error;
  }
}

/* ---------- 重试工具函数 ---------- */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 1000,
  operationName: string = "操作"
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      enhancedLog("RETRY_ATTEMPT", {
        operation: operationName,
        attempt,
        maxRetries
      });
      
      const result = await fn();
      
      if (attempt > 1) {
        enhancedLog("RETRY_SUCCESS", {
          operation: operationName,
          successOnAttempt: attempt
        });
      }
      
      return result;
    } catch (error) {
      lastError = error as Error;
      
      enhancedLog("RETRY_FAILED", {
        operation: operationName,
        attempt,
        maxRetries,
        error: String(error)
      });
      
      if (attempt < maxRetries) {
        const delay = initialDelay * Math.pow(2, attempt - 1); // 指数退避
        enhancedLog("RETRY_WAITING", {
          operation: operationName,
          waitMs: delay,
          nextAttempt: attempt + 1
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  enhancedLog("RETRY_EXHAUSTED", {
    operation: operationName,
    totalAttempts: maxRetries,
    finalError: String(lastError)
  });
  
  throw lastError || new Error(`${operationName} 失败，已重试 ${maxRetries} 次`);
}

async function createApiKey(sessionToken: string, userId: string, userEmail: string, keyName: string) {
  const url = `${TETRATE_ROUTER_BASE}/create-api-key`;
  
  try {
    // 优先使用手工配置的 next-action（位于文件顶部）
    let actionId: string | null = (NEXT_ACTION.CREATE_API_KEY_MANUAL || "").trim() || null;
    if (actionId) {
      enhancedLog("USING_MANUAL_ACTION_ID", {
        actionIdPreview: actionId.substring(0, 20) + "..."
      });
    } else {
      // 步骤1: 访问页面并尝试自动提取 action ID
      enhancedLog("CREATE_API_KEY_STEP1", { message: "获取页面以提取 action ID" });
      
      const pageResponse = await fetch(url, {
        method: "GET",
        headers: {
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "cookie": `__Secure-fraser.session_token=${sessionToken}`,
          "referer": `${TETRATE_ROUTER_BASE}/dashboard`,
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
        }
      });
      
      if (!pageResponse.ok) {
        enhancedLog("PAGE_FETCH_ERROR", {
          status: pageResponse.status,
          statusText: pageResponse.statusText
        });
        throw new Error(`获取页面失败: HTTP ${pageResponse.status}`);
      }
      
      const pageHtml = await pageResponse.text();
      
      enhancedLog("PAGE_FETCH_SUCCESS", {
        htmlLength: pageHtml.length,
        htmlPreview: pageHtml.substring(0, 500)
      });
      
      // 步骤2: 从页面中提取 action ID (多种模式尝试)
      // 尝试多种提取模式
      const patterns = [
        // Next.js 13+ Server Actions 格式
        /"([a-f0-9]{40,})"/g,  // 所有40+位的十六进制字符串
        /action["\s:=]+["']?([a-f0-9]{40,})["']?/gi,
        /next-action["\s:=]+["']?([a-f0-9]{40,})["']?/gi,
        /formAction["\s:=]+["']?([a-f0-9]{40,})["']?/gi,
        /data-action["\s:=]+["']?([a-f0-9]{40,})["']?/gi,
        // 直接查找长十六进制字符串
        /\b([a-f0-9]{40,})\b/g
      ];
      
      const foundIds: string[] = [];
      
      for (const pattern of patterns) {
        const matches = pageHtml.matchAll(pattern);
        for (const match of matches) {
          const id = match[1];
          if (id && id.length >= 40 && /^[a-f0-9]+$/.test(id)) {
            foundIds.push(id);
          }
        }
      }
      
      // 去重并记录所有找到的 ID
      const uniqueIds = [...new Set(foundIds)];
      
      enhancedLog("ACTION_ID_SEARCH", {
        totalFound: uniqueIds.length,
        foundIds: uniqueIds.slice(0, 5), // 只显示前5个
        htmlContainsForm: pageHtml.includes('<form'),
        htmlContainsAction: pageHtml.includes('action'),
        htmlContainsButton: pageHtml.includes('button')
      });
      
      // 优先选择最长的 ID（通常是 action ID）
      if (uniqueIds.length > 0) {
        actionId = uniqueIds.sort((a, b) => b.length - a.length)[0];
        enhancedLog("EXTRACTED_ACTION_ID", {
          actionId,
          length: actionId.length,
          source: "pattern_match"
        });
      }
      
      if (!actionId) {
        throw new Error("未找到有效的 next-action。请在文件顶部 NEXT_ACTION.CREATE_API_KEY_MANUAL 中填写最新的 Action ID");
      }
    }

    const usedActionId = actionId as string;

    // 步骤3: 构建请求
    const headers = {
      "accept": "text/x-component",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "content-type": "text/plain;charset=UTF-8",
      "cookie": `__Secure-fraser.session_token=${sessionToken}`,
      "origin": TETRATE_ROUTER_BASE,
      "referer": `${TETRATE_ROUTER_BASE}/create-api-key`,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      "next-action": usedActionId,
      "next-router-state-tree": "%5B%22%22%2C%7B%22children%22%3A%5B%22(dashboard)%22%2C%7B%22children%22%3A%5B%22create-api-key%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%2Ctrue%5D",
      "sec-ch-ua": '"Chromium";v="140", "Not=A?Brand";v="24", "Microsoft Edge";v="140"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin"
    };

    const body = JSON.stringify([{
      userId: userId,
      userEmail: userEmail,
      keyName: keyName,
      budget: "100",
      priority: "quality",
      customSettings: {
        maxAttempts: 3,
        retryDelay: 30,
        enableCaching: true,
        budgetLimit: 100,
        retryOnRateLimit: true,
        retryOnModelUnavailable: true,
        retryOnTimeout: true,
        customModels: []
      }
    }]);

    enhancedLog("CREATE_API_KEY_REQUEST", {
      url,
      actionId: usedActionId,
      bodyLength: body.length
    });

    // 步骤4: 发送创建请求
    const response = await fetch(url, {
      method: "POST",
      headers: headers as any,
      body: body,
    });

    const responseText = await response.text();
    
    // 步骤5: 详细记录响应
    enhancedLog("CREATE_API_KEY_RESPONSE", {
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type"),
      responseLength: responseText.length,
      responsePreview: responseText.substring(0, 1000)
    });
    
    // 步骤6: 尝试多种格式提取 API Key
    let apiKey = null;
    
    // 模式1: JSON 格式 "apiKey":"sk-..."
    let match = responseText.match(/"apiKey"\s*:\s*"(sk-[a-zA-Z0-9.\/+\-_=]+)"/);
    if (match) {
      apiKey = match[1];
      enhancedLog("API_KEY_EXTRACTED", { method: "JSON format", keyPreview: apiKey.substring(0, 20) + "..." });
    }
    
    // 模式2: 直接匹配 sk- 开头的字符串
    if (!apiKey) {
      match = responseText.match(/sk-[a-zA-Z0-9.\/+\-_=]{30,}/);
      if (match) {
        apiKey = match[0];
        enhancedLog("API_KEY_EXTRACTED", { method: "Direct match", keyPreview: apiKey.substring(0, 20) + "..." });
      }
    }
    
    // 模式3: 查找任何类似 key 的字段
    if (!apiKey) {
      match = responseText.match(/(?:key|apiKey|api_key)\s*[":=]\s*["']?(sk-[a-zA-Z0-9.\/+\-_=]+)["']?/i);
      if (match) {
        apiKey = match[1];
        enhancedLog("API_KEY_EXTRACTED", { method: "Flexible match", keyPreview: apiKey.substring(0, 20) + "..." });
      }
    }
    
    if (!apiKey) {
      enhancedLog("CREATE_API_KEY_ERROR", {
        message: "未能从响应中提取 API Key",
        response: responseText.substring(0, 500),
        fullResponseLength: responseText.length
      });
      throw new Error("未能从响应中提取 API Key");
    }

    enhancedLog("CREATE_API_KEY_SUCCESS", { apiKey: apiKey.substring(0, 20) + "..." });
    return apiKey;
  } catch (error) {
    enhancedLog("CREATE_API_KEY_ERROR", {
      message: String(error),
      stack: (error as Error).stack
    });
    throw error;
  }
}

/* ---------- 简化版自动注册流程(只保留关键步骤) ---------- */
async function autoRegisterSimplified() {
  try {
    // 步骤1: 创建临时邮箱
    const email = await createTempEmail();
    const password = generatePassword();
    const name = email.split('@')[0];
    log("AUTO_REGISTER_STEP", { step: 1, message: "临时邮箱创建成功", email, password, name });

    // 步骤2: 注册 Tetrate AI 账户
    const registerResponse = await registerWithTetrate(email, password, name);
    const userId = (registerResponse as any)?.user?.id;
    if (!userId) {
      throw new Error("注册响应中未找到用户ID");
    }
    log("AUTO_REGISTER_STEP", { step: 2, message: "Tetrate AI 注册成功", userId });
    
    // 步骤3: 等待并提取验证链接
    let verificationToken: string | null = null;
    let attempts = 0;
    const maxAttempts = 30;
    
    while (!verificationToken && attempts < maxAttempts) {
      attempts++;
      log("AUTO_REGISTER_STEP", {
        step: 3,
        message: `等待验证邮件 (尝试 ${attempts}/${maxAttempts})`
      });
      
      const delay = attempts <= 3 ? 1000 : 2000;
      await new Promise((resolve) => setTimeout(resolve, delay));
      
      try {
        const messages = await getMailbox();
        
        for (const message of messages) {
          if (
            message.subject.toLowerCase().includes("verify") ||
            message.subject.toLowerCase().includes("verification") ||
            message.from.toLowerCase().includes("tetrate") ||
            message.from.toLowerCase().includes("noreply")
          ) {
            const emailDetails = await getEmailDetails(message.id);
            const emailContent = emailDetails.html || emailDetails.text || "";
            
            const tokenMatch = emailContent.match(/token=([a-zA-Z0-9._-]+)/);
            if (tokenMatch) {
              verificationToken = tokenMatch[1];
              log("AUTO_REGISTER_STEP", {
                step: 3,
                message: "验证 token 已找到",
                token: verificationToken.substring(0, 20) + "...",
                from: message.from,
                subject: message.subject
              });
              break;
            }
          }
        }
        
        if (verificationToken) break;
      } catch (error) {
        log("MAILBOX_CHECK_ERROR", {
          attempt: attempts,
          error: String(error)
        });
      }
    }
    
    if (!verificationToken) {
      throw new Error(`未能找到验证 token（已尝试 ${maxAttempts} 次）`);
    }

    // 步骤4: 验证邮箱并获取 session token
    log("AUTO_REGISTER_STEP", { step: 4, message: "正在验证邮箱..." });
    const sessionToken = await verifyEmailWithToken(
      verificationToken,
      TETRATE_CALLBACK_URL
    );
    log("AUTO_REGISTER_STEP", { step: 4, message: "邮箱验证成功，已获取 session token" });

    // 步骤4.5: 只执行关键的浏览器行为(获得余额的最少步骤)
    try {
      log("AUTO_REGISTER_STEP", {
        step: 4,
        message: "执行关键浏览器行为..."
      });
      
      // 关键步骤: Heap Analytics (signin) - 这是获得余额的关键!
      await sendHeapAnalytics("signin");
      const balance = await preloadDashboard(sessionToken);
      log("BALANCE_AFTER_KEY_REQUEST", { request: "heap_signin", balance });
      
      log("AUTO_REGISTER_STEP", {
        step: 4,
        message: "关键浏览器行为完成"
      });
    } catch (error) {
      log("BROWSER_SIMULATION_WARNING", {
        message: "浏览器行为模拟部分失败，但继续流程",
        error: String(error)
      });
    }

    // 步骤5: 创建 API Key
    log("AUTO_REGISTER_STEP", { step: 5, message: "正在创建 API Key..." });
    
    const apiKey = await retryWithBackoff(
      () => createApiKey(
        sessionToken,
        userId,
        email,
        `AutoKey-${generateRandomString(4)}`
      ),
      3, // 最多重试3次
      2000, // 初始延迟2秒
      "创建API Key"
    );
    log("AUTO_REGISTER_SUCCESS", { apiKey: apiKey.substring(0, 30) + "..." });

    return {
      status: "success",
      message: "简化版自动注册成功",
      email,
      password,
      userId,
      apiKey,
    };
  } catch (error) {
    log("AUTO_REGISTER_ERROR", {
      message: String(error),
      stack: (error as Error).stack
    });
    return {
      status: "error",
      message: String(error),
    };
  }
}

/* ---------- HTML 模板 ---------- */
function getHtmlTemplate() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tetrate AI 自动注册 & 获取 API Key</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
      line-height: 1.6;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
      text-align: center;
    }
    .header h1 {
      font-size: 28px;
      margin-bottom: 10px;
    }
    .header p {
      opacity: 0.9;
      font-size: 14px;
    }
    .content {
      padding: 30px;
    }
    button {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 14px 32px;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 16px;
      font-weight: 600;
      transition: all 0.3s;
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
      display: block;
      margin: 0 auto 30px;
    }
    button:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6);
    }
    button:active:not(:disabled) {
      transform: translateY(0);
    }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .loader {
      border: 4px solid #f3f3f3;
      border-top: 4px solid #667eea;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
      margin: 20px auto;
      display: none;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    #steps-container {
      display: none;
      margin-bottom: 30px;
    }
    #steps-container h2 {
      color: #333;
      margin-bottom: 20px;
      font-size: 20px;
    }
    .step {
      margin: 12px 0;
      padding: 16px;
      border-left: 4px solid #ddd;
      background: #f9f9f9;
      border-radius: 4px;
      transition: all 0.3s;
    }
    .step.active {
      border-left-color: #667eea;
      background: #e8eaf6;
      animation: pulse 2s infinite;
    }
    .step.completed {
      border-left-color: #4caf50;
      background: #e8f5e9;
    }
    .step.error {
      border-left-color: #f44336;
      background: #ffebee;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.8; }
    }
    .account-info {
      background: linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%);
      padding: 25px;
      border-radius: 12px;
      margin-top: 20px;
      border: 2px solid #4caf50;
      display: none;
    }
    .account-info h3 {
      color: #2e7d32;
      margin-bottom: 20px;
      font-size: 22px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .account-info .info-row {
      margin: 12px 0;
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }
    .account-info .label {
      font-weight: 600;
      color: #1b5e20;
      min-width: 90px;
      padding-top: 8px;
    }
    .account-info code {
      background: #ffffff;
      padding: 8px 12px;
      border-radius: 6px;
      font-family: 'Courier New', monospace;
      font-size: 13px;
      color: #2e7d32;
      border: 1px solid #a5d6a7;
      word-break: break-all;
      flex: 1;
    }
    .error-info {
      background: linear-gradient(135deg, #ffebee 0%, #ffcdd2 100%);
      border-color: #f44336;
    }
    .error-info h3 {
      color: #c62828;
    }
    .error-info .label {
      color: #b71c1c;
    }
    .error-info code {
      background: #ffffff;
      color: #c62828;
      border-color: #ef9a9a;
    }
    #result-container {
      display: none;
      margin-top: 20px;
    }
    #result-container h3 {
      color: #333;
      margin-bottom: 10px;
    }
    pre {
      background: #f5f5f5;
      padding: 15px;
      border-radius: 8px;
      overflow-x: auto;
      font-size: 13px;
      border: 1px solid #ddd;
      max-height: 400px;
      overflow-y: auto;
    }
    .warning {
      background: #fff3cd;
      border: 1px solid #ffc107;
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 20px;
      color: #856404;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🚀 Tetrate AI 自动注册工具</h1>
      <p>支持简化注册或仅获取注册链接</p>
    </div>
    
    <div class="content">
      <div class="warning">
        ⏱️ <strong>注意：</strong>整个流程大约需要 2-3 分钟，请耐心等待，不要关闭页面。
      </div>
      
      <button id="simplifiedRegisterBtn" style="background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);">⚡ 简化版注册（快速获取API Key）</button>
      <button id="getRegLinkBtn" style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); margin-top: 10px;">🔗 仅获取注册链接</button>
      <div class="loader" id="simplifiedRegisterLoader"></div>
      <div class="loader" id="getRegLinkLoader"></div>
      
      <div id="steps-container">
        <h2>📋 注册进度</h2>
        <div class="step" id="step1">步骤 1: 创建临时邮箱</div>
        <div class="step" id="step2">步骤 2: 注册 Tetrate AI 账户</div>
        <div class="step" id="step3">步骤 3: 获取验证邮件</div>
        <div class="step" id="step4">步骤 4: 验证邮箱</div>
        <div class="step" id="step5">步骤 5: 创建 API Key</div>
      </div>
      
      <div class="account-info" id="account-info">
        <h3>🎉 注册成功！</h3>
        <div class="info-row">
          <span class="label">邮箱:</span>
          <code id="account-email">-</code>
        </div>
        <div class="info-row">
          <span class="label">密码:</span>
          <code id="account-password">-</code>
        </div>
        <div class="info-row">
          <span class="label">用户ID:</span>
          <code id="account-userId">-</code>
        </div>
        <div class="info-row">
          <span class="label">API Key:</span>
          <code id="account-apiKey">-</code>
        </div>
        <div class="info-row" id="verification-link-row" style="display: none;">
          <span class="label">验证链接:</span>
          <code id="account-verificationLink">-</code>
        </div>
      </div>
      
      <div id="result-container">
        <h3>📄 详细结果</h3>
        <pre id="autoRegisterData"></pre>
      </div>
    </div>
  </div>

  <script>
    // 简化版自动注册
    document.getElementById('simplifiedRegisterBtn').addEventListener('click', async () => {
      const resultElement = document.getElementById('autoRegisterData');
      const loader = document.getElementById('simplifiedRegisterLoader');
      const stepsContainer = document.getElementById('steps-container');
      const accountInfo = document.getElementById('account-info');
      const resultContainer = document.getElementById('result-container');
      const btn = document.getElementById('simplifiedRegisterBtn');
      
      btn.disabled = true;
      document.getElementById('getRegLinkBtn').disabled = true;
      btn.textContent = '⏳ 快速注册中...';
      resultElement.textContent = '简化版注册流程启动，请稍候...';
      loader.style.display = 'block';
      stepsContainer.style.display = 'block';
      accountInfo.style.display = 'none';
      resultContainer.style.display = 'block';
      accountInfo.className = 'account-info';
      document.getElementById('verification-link-row').style.display = 'none';
      
      // 重置步骤
      for (let i = 1; i <= 5; i++) {
        const step = document.getElementById('step' + i);
        step.className = 'step';
        step.textContent = '步骤 ' + i + ': 等待中...';
      }
      
      // 轮询进度
      let progressInterval = setInterval(async () => {
        try {
          const progressResponse = await fetch('/api/auto-register/progress');
          if (!progressResponse.ok) return;
          const progressData = await progressResponse.json();
          if (progressData.steps) {
            for (const [stepNum, stepInfo] of Object.entries(progressData.steps)) {
              const stepEl = document.getElementById('step' + stepNum);
              if (stepEl) {
                stepEl.className = 'step ' + stepInfo.status;
                const baseText = '步骤 ' + stepNum;
                stepEl.textContent = \`\${baseText}: \${stepInfo.message}\`;
              }
            }
          }
        } catch (e) {
          console.error('获取进度失败:', e);
        }
      }, 1500);
      
      try {
        const response = await fetch('/api/auto-register-simplified', { method: 'POST' });
        const data = await response.json();
        resultElement.textContent = JSON.stringify(data, null, 2);
        
        if (data.status === 'success') {
          document.getElementById('account-email').textContent = data.email;
          document.getElementById('account-password').textContent = data.password;
          document.getElementById('account-userId').textContent = data.userId || 'N/A';
          document.getElementById('account-apiKey').textContent = data.apiKey;
          accountInfo.style.display = 'block';
          btn.textContent = '✅ 快速注册成功！';
        } else {
          document.getElementById('account-email').textContent = '失败';
          document.getElementById('account-password').textContent = '失败';
          document.getElementById('account-userId').textContent = '失败';
          document.getElementById('account-apiKey').textContent = data.message;
          accountInfo.className = 'account-info error-info';
          accountInfo.querySelector('h3').textContent = '❌ 注册失败';
          accountInfo.style.display = 'block';
          btn.textContent = '❌ 注册失败';
        }
      } catch (error) {
        resultElement.textContent = '客户端错误: ' + error.message;
        accountInfo.className = 'account-info error-info';
        accountInfo.querySelector('h3').textContent = '❌ 客户端错误';
        accountInfo.style.display = 'block';
        btn.textContent = '❌ 发生错误';
      } finally {
        clearInterval(progressInterval);
        loader.style.display = 'none';
        btn.disabled = false;
        document.getElementById('getRegLinkBtn').disabled = false;
        setTimeout(() => {
          if (btn.textContent.includes('成功') || btn.textContent.includes('失败')) {
            btn.textContent = '🔄 重新快速注册';
          }
        }, 2000);
      }
    });

    // 仅获取注册链接
    document.getElementById('getRegLinkBtn').addEventListener('click', async () => {
      const resultElement = document.getElementById('autoRegisterData');
      const loader = document.getElementById('getRegLinkLoader');
      const stepsContainer = document.getElementById('steps-container');
      const accountInfo = document.getElementById('account-info');
      const resultContainer = document.getElementById('result-container');
      const btn = document.getElementById('getRegLinkBtn');
      
      btn.disabled = true;
      document.getElementById('simplifiedRegisterBtn').disabled = true;
      btn.textContent = '⏳ 获取中...';
      resultElement.textContent = '正在获取注册链接，请稍候...';
      loader.style.display = 'block';
      stepsContainer.style.display = 'block';
      accountInfo.style.display = 'none';
      resultContainer.style.display = 'block';
      accountInfo.className = 'account-info';
      document.getElementById('verification-link-row').style.display = 'none';
      
      // 重置步骤（只显示3个步骤）
      for (let i = 1; i <= 5; i++) {
        const step = document.getElementById('step' + i);
        if (i <= 3) {
          step.style.display = 'block';
          step.className = 'step';
          step.textContent = '步骤 ' + i + ': 等待中...';
        } else {
          step.style.display = 'none';
        }
      }
      
      // 轮询进度
      let progressInterval = setInterval(async () => {
        try {
          const progressResponse = await fetch('/api/auto-register/progress');
          if (!progressResponse.ok) return;
          const progressData = await progressResponse.json();
          if (progressData.steps) {
            for (const [stepNum, stepInfo] of Object.entries(progressData.steps)) {
              const stepEl = document.getElementById('step' + stepNum);
              if (stepEl && parseInt(stepNum) <= 3) {
                stepEl.className = 'step ' + stepInfo.status;
                const baseText = '步骤 ' + stepNum;
                stepEl.textContent = \`\${baseText}: \${stepInfo.message}\`;
              }
            }
          }
        } catch (e) {
          console.error('获取进度失败:', e);
        }
      }, 1500);
      
      try {
        const response = await fetch('/api/get-registration-link', { method: 'POST' });
        const data = await response.json();
        resultElement.textContent = JSON.stringify(data, null, 2);
        
        if (data.status === 'success') {
          document.getElementById('account-email').textContent = data.email;
          document.getElementById('account-password').textContent = data.password;
          document.getElementById('account-userId').textContent = data.userId || 'N/A';
          document.getElementById('account-apiKey').textContent = '未获取（仅获取链接模式）';
          document.getElementById('account-verificationLink').textContent = data.verificationLink;
          document.getElementById('verification-link-row').style.display = 'flex';
          accountInfo.style.display = 'block';
          btn.textContent = '✅ 获取成功！';
        } else {
          document.getElementById('account-email').textContent = '失败';
          document.getElementById('account-password').textContent = '失败';
          document.getElementById('account-userId').textContent = '失败';
          document.getElementById('account-apiKey').textContent = data.message;
          accountInfo.className = 'account-info error-info';
          accountInfo.querySelector('h3').textContent = '❌ 获取失败';
          accountInfo.style.display = 'block';
          btn.textContent = '❌ 获取失败';
        }
      } catch (error) {
        resultElement.textContent = '客户端错误: ' + error.message;
        accountInfo.className = 'account-info error-info';
        accountInfo.querySelector('h3').textContent = '❌ 客户端错误';
        accountInfo.style.display = 'block';
        btn.textContent = '❌ 发生错误';
      } finally {
        clearInterval(progressInterval);
        loader.style.display = 'none';
        btn.disabled = false;
        document.getElementById('simplifiedRegisterBtn').disabled = false;
        // 恢复所有步骤显示
        for (let i = 4; i <= 5; i++) {
          document.getElementById('step' + i).style.display = 'block';
        }
        setTimeout(() => {
          if (btn.textContent.includes('成功') || btn.textContent.includes('失败')) {
            btn.textContent = '🔄 重新获取';
          }
        }, 2000);
      }
    });
  </script>
</body>
</html>`;
}

/* ---------- 请求处理 ---------- */
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // 简化版自动注册接口
  if (url.pathname === "/api/auto-register-simplified" && req.method === "POST") {
    Object.keys(registrationProgress.steps).forEach(key => delete registrationProgress.steps[key]);
    registrationProgress.isRunning = true;
    for (let i = 1; i <= 5; i++) {
      updateProgress(i, "waiting", "等待中...");
    }

    const result = await autoRegisterSimplified();
    registrationProgress.isRunning = false;
    
    if (result.status === "success") {
      for (let i = 1; i <= 5; i++) {
        const step = registrationProgress.steps[i];
        if (step && step.status !== "error") {
          step.status = 'completed';
        }
      }
    }
    
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" }
    });
  }
  
  // 获取注册链接接口
  if (url.pathname === "/api/get-registration-link" && req.method === "POST") {
    Object.keys(registrationProgress.steps).forEach(key => delete registrationProgress.steps[key]);
    registrationProgress.isRunning = true;
    for (let i = 1; i <= 3; i++) {
      updateProgress(i, "waiting", "等待中...");
    }

    const result = await getRegistrationLink();
    registrationProgress.isRunning = false;
    
    if (result.status === "success") {
      for (let i = 1; i <= 3; i++) {
        const step = registrationProgress.steps[i];
        if (step && step.status !== "error") {
          step.status = 'completed';
        }
      }
    }
    
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" }
    });
  }


  // 进度查询接口
  if (url.pathname === "/api/auto-register/progress") {
    return new Response(JSON.stringify(registrationProgress), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // 根路径返回 HTML
  if (url.pathname === "/") {
    return new Response(getHtmlTemplate(), {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }

  return new Response("Not Found", { status: 404 });
}

/* ---------- 启动服务器 ---------- */
console.log(`🚀 Tetrate AI 自动注册服务器已启动`);
console.log(`📡 访问地址: http://localhost:${PORT}`);
serve(handleRequest, { port: PORT });
