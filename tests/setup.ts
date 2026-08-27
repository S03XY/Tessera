import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local"), quiet: true });

process.env.NEXT_PUBLIC_BASE_URL ??= "http://localhost:3000";
