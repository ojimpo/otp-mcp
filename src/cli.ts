// CLIモード: MCPを介さず直接OTPに問い合わせる。動作確認・デバッグ用。
//   node build/index.js plan 新宿 渋谷
//   node build/index.js suggest 新宿
import { resolvePlace, suggestStations, planJourney, formatJourney, formatStations } from "./otp.js";

export async function runCli(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  if (cmd === "plan") {
    const [from, to, n] = rest;
    if (!from || !to) {
      console.error("usage: otp-mcp plan <from> <to> [numItineraries]");
      process.exit(1);
    }
    const f = await resolvePlace(from);
    const t = await resolvePlace(to);
    const itins = await planJourney(f, t, n ? parseInt(n, 10) : 3);
    console.log(formatJourney(f, t, itins));
  } else if (cmd === "suggest") {
    const [q, limit] = rest;
    if (!q) {
      console.error("usage: otp-mcp suggest <query> [limit]");
      process.exit(1);
    }
    console.log(formatStations(await suggestStations(q, limit ? parseInt(limit, 10) : 10)));
  } else {
    console.error(`unknown command: ${cmd ?? "(none)"}\ncommands:\n  plan <from> <to> [n]\n  suggest <query> [limit]`);
    process.exit(1);
  }
}
