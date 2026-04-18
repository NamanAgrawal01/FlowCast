import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const env = process.env;

function requireEnv(name) {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  firebase: {
    apiKey: requireEnv("FIREBASE_API_KEY"),
    authDomain: requireEnv("FIREBASE_AUTH_DOMAIN"),
    databaseURL: requireEnv("FIREBASE_DATABASE_URL"),
    projectId: requireEnv("FIREBASE_PROJECT_ID"),
    storageBucket: requireEnv("FIREBASE_STORAGE_BUCKET"),
    messagingSenderId: requireEnv("FIREBASE_MESSAGING_SENDER_ID"),
    appId: requireEnv("FIREBASE_APP_ID")
  },
  functionsRegion: env.FIREBASE_FUNCTIONS_REGION || "us-central1",
  functionsBaseUrl:
    env.FIREBASE_FUNCTIONS_BASE_URL ||
    `https://${env.FIREBASE_FUNCTIONS_REGION || "us-central1"}-${requireEnv("FIREBASE_PROJECT_ID")}.cloudfunctions.net`,
  stateDir: path.resolve(process.cwd(), env.DEVICE_STATE_DIR || ".agent-state"),
  stunServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

