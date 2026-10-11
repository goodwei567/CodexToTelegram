# Codex Telegram Bridge
涓€涓鏈夌殑 Telegram Bot,杩炴帴鍒版湰鍦拌繍琛岀殑 Codex app-server daemon,涓?Codex 鎻愪緵 Telegram 鐣岄潰銆?
[English](#english) | [涓枃](#涓枃)
---
## 涓枃
### 鍔熻兘鐗规€?
**鍩虹鍔熻兘**
- 閫氳繃 Telegram 涓?Codex 杩涜瀵硅瘽
- 鏀寔鏂囨湰鍜屽浘鐗囪緭鍏?- 瀹炴椂鏄剧ず Codex 鍥炲悎杩涘害
- 浼氳瘽鍘嗗彶绠＄悊鍜屾悳绱?- 妯″瀷鍜屾潈闄愭ā寮忓垏鎹?
**浼氳瘽绠＄悊** (鏂板)
- \/cwd\ - 鏌ョ湅鎴栧垏鎹㈠伐浣滅洰褰?- \/rename\ - 閲嶅懡鍚嶅綋鍓嶄細璇?- \/archive\ - 褰掓。褰撳墠浼氳瘽
- \/fork\ - 鍒嗗弶浼氳瘽鍒版柊涓婚
- \/compact\ - 鍘嬬缉浼氳瘽鍘嗗彶
- \/effort\ - 璁剧疆鎺ㄧ悊寮哄害 (low/medium/high/ultra)
**澧炲己鐗规€?*
- 鑷姩娉ㄥ唽 Telegram 鍛戒护鍒楄〃(杈撳叆 \/\ 鍗冲彲鐪嬪埌鎵€鏈夊懡浠?
- 杩涘害鏄剧ず澧炲己(鏄剧ず姝ｅ湪鎵ц鐨勫懡浠ゅ拰鏂囦欢淇敼)
- 杈撳叆娴佸拰瀹℃壒瓒呮椂鑷姩娓呯悊
- 鍚姩澶辫触鑷姩閲嶈瘯(3娆?鎸囨暟閫€閬?
- 杩炴帴鏃ュ織璁板綍鍒?\.runtime/bridge.log\
### 绯荤粺瑕佹眰
- Windows 绯荤粺,Node.js 22.21 鎴栨洿鏂扮増鏈?- 宸插畨瑁呭苟鐧诲綍鐨?Codex CLI
- Codex app-server daemon 鍦ㄥ悓涓€ Windows 璐︽埛涓嬭繍琛?- 浠?\@BotFather\ 鑾峰彇鐨?Telegram bot token
Bridge 浣跨敤 Telegram 闀胯疆璇㈠拰鏈湴 Codex 鎺у埗濂楁帴瀛?涓嶅紑鏀惧叕缃戠鍙ｃ€?鍦?Windows 涓?鍚姩鑴氭湰浼氳鍙栧綋鍓嶇敤鎴风殑浠ｇ悊璁剧疆(褰?\HTTP_PROXY\ 鍜?\HTTPS_PROXY\ 鏈缃椂),骞堕厤缃?Node.js 浣跨敤璇ヤ唬鐞?鍚屾椂淇濇寔 localhost 娴侀噺鐩磋繛銆?
### 棣栨閰嶇疆
1. 鍦?Telegram 涓墦寮€ \@BotFather\,杩愯 \/newbot\,鎸夌収鎻愮ず鎿嶄綔銆傝濡ュ杽淇濈 token銆?
2. 鍦?PowerShell 涓?杩涘叆椤圭洰鐩綍骞朵繚瀛?token:
   \\\powershell
   .\scripts\save-token.ps1
   \\\
   Windows 浣跨敤 DPAPI 涓哄綋鍓嶈处鎴峰姞瀵?token,骞跺瓨鍌ㄥ湪 \.runtime\ 涓嬨€?
3. 澶嶅埗閰嶇疆鏂囦欢妯℃澘:
   \\\powershell
   Copy-Item bridge.config.example.json bridge.config.json
   \\\
   鏍规嵁闇€瑕佷慨鏀?\ridge.config.json\ 涓殑宸ヤ綔鐩綍鍜屽厑璁哥殑璺緞銆?
4. 瀹夎渚濊禆:
   \\\powershell
   npm install
   \\\
5. 鍚姩 Bridge:
   \\\powershell
   .\scripts\start.ps1
   \\\
   缁堢浼氭樉绀轰竴娆℃€ч厤瀵圭爜,20鍒嗛挓鍚庤繃鏈熴€?
6. 鍦?Telegram 涓墦寮€浣犵殑鏂?bot,鎸?**Start**,鐒跺悗鍙戦€?\/pair YOUR_CODE\,浣跨敤缁堢涓樉绀虹殑閰嶅鐮併€?
7. 鍙戦€?\/help\ 鏌ョ湅鍛戒护鍒楄〃,鍙戦€?\/new\ 鍒涘缓 Codex 浼氳瘽銆傚彂閫?\/new 涓婚鍚峔 鍙互鍦ㄥ惎鐢ㄧ浜鸿瘽棰樻椂鍒涘缓 Telegram 璇濋銆?
Bridge 缁戝畾鍒扮涓€涓垚鍔熼厤瀵圭殑 Telegram 鐢ㄦ埛,浼氬拷鐣ュ叾浠栬处鎴风殑娑堟伅鍜屾墍鏈夌兢鑱婃秷鎭€?
### 鍛戒护鍒楄〃
- \/new [涓婚鍚峕\ 鈥?鏂板缓 Codex 浼氳瘽,鍚敤璇濋鏃跺垱寤?Telegram 璇濋
- \/history\ 鈥?娴忚鏈€杩戠殑 Codex 浼氳瘽骞跺湪褰撳墠璇濋涓仮澶?- \/search 鍏抽敭璇峔 鈥?鎼滅储淇濆瓨鐨勪細璇濆巻鍙?- \/open 浼氳瘽ID\ 鈥?閫氳繃 ID 鎭㈠浼氳瘽
- \/model\ 鈥?浠庢湰鍦颁唬鐞嗙殑 \/v1/models\ 鍝嶅簲涓€夋嫨妯″瀷
- \/permission\ 鈥?閫夋嫨鍙銆侀」鐩啓鍏ユ垨瀹屽叏涓嶅彈闄愮殑璁块棶鏉冮檺
- \/status\ 鈥?鏌ョ湅褰撳墠绾跨▼銆佹ā鍨嬨€佸伐浣滃尯鍜屾潈闄?- \/stop\ 鈥?涓柇褰撳墠 Codex 鍥炲悎
- \/cwd [璺緞]\ 鈥?鏌ョ湅鎴栧垏鎹㈠伐浣滅洰褰?- \/rename 鍚嶇О\ 鈥?閲嶅懡鍚嶅綋鍓嶄細璇?- \/archive\ 鈥?褰掓。褰撳墠浼氳瘽
- \/fork [涓婚]\ 鈥?鍒嗗弶浼氳瘽鍒版柊涓婚
- \/compact\ 鈥?鍘嬬缉浼氳瘽鍘嗗彶
- \/effort\ 鈥?璁剧疆鎺ㄧ悊寮哄害
鐩存帴鍙戦€佹枃瀛楁垨鍥剧墖鍗冲彲浜ょ粰 Codex 澶勭悊銆?
榛樿宸ヤ綔鍖哄拰妯″瀷鍒楄〃绔偣鍦?\ridge.config.json\ 涓厤缃€侭ot 鍦ㄥ簲鐢ㄦā鍨嬪墠浼氬啀娆℃鏌ヤ唬鐞嗘ā鍨嬪垪琛ㄣ€傚浘鐗囦笅杞介檺鍒朵负 20 MB,瀛樺偍鍦?\.runtime/attachments\ 涓嬨€?
### 绉佷汉璇濋
鍦?\@BotFather\ 涓负 bot 鐨勭浜鸿亰澶╁惎鐢ㄨ瘽棰樺姛鑳?濡傛灉浣犲笇鏈涙瘡涓?Codex 浼氳瘽瀵瑰簲涓€涓?Telegram 璇濋銆傛病鏈夎瘽棰樻椂 Bridge 浠嶅彲宸ヤ綔,浣?\/new\ 浼氬皢鍗曚釜绉佷汉鑱婂ぉ鍒囨崲鍒版柊浼氳瘽;鏃╂湡浼氳瘽浠嶅彲閫氳繃 \/history\ 璁块棶銆?
### 鍙€夎嚜鍔ㄥ惎鍔?
閰嶅 bot 鍚?瀹夎姣忕敤鎴?Windows 鐧诲綍浠诲姟:
\\\powershell
.\scripts\install-autostart.ps1
\\\
绉婚櫎浠诲姟:
\\\powershell
.\scripts\remove-autostart.ps1
\\\
浠诲姟鍦?Windows 璐︽埛鐧诲綍鍚庤繍琛屻€傚鏋滈渶瑕?bot 鎸佺画鍙敤,璇峰湪鎻掔數鏃朵繚鎸佽绠楁満鍞ら啋;鐫＄湢浼氭殏鍋?Telegram 杞鍜屾湰鍦?Codex 璁块棶銆?
### 鏁版嵁鍜屽畨鍏?
- \.runtime\ 宸叉帓闄ゅ湪 Git 涔嬪銆侭ot token 浣跨敤 Windows DPAPI 涓哄綋鍓嶈处鎴峰姞瀵嗐€?- 閰嶅鐘舵€併€乀elegram 鏇存柊鍋忕Щ閲忋€佽瘽棰樺埌绾跨▼鐨勬槧灏勪互鍙婁笅杞界殑鍥剧墖鍧囧瓨鍌ㄥ湪 \.runtime\ 鏈湴銆?- Codex 瀛愯繘绋嬩笉缁ф壙 \TELEGRAM_BOT_TOKEN\銆?- 鏂扮嚎绋嬩互椤圭洰鍐欏叆璁块棶鍜?\on-request\ 瀹℃壒寮€濮嬨€傚畬鍏ㄤ笉鍙楅檺鐨勮闂渶瑕佸湪 Telegram 涓繘琛屼簩娆＄‘璁ゃ€?- App-server 鍗忚鏄疄楠屾€х殑,鍙兘浼氶殢 Codex CLI 鏇存柊鑰屽彉鍖栥€侰LI 鏇存柊鍚庤閲嶆柊鏋勫缓 Bridge銆?- 濡傛灉 Telegram 鎶ュ憡宸查厤缃?webhook,璇存槑姝?bot token 宸茶鍩轰簬 webhook 鐨勬湇鍔′娇鐢ㄣ€傝绉婚櫎璇?webhook 鎴栧湪鍚姩闀胯疆璇?Bridge 鍓嶅垱寤烘柊鐨?bot token銆?
### 閰嶇疆璇存槑
\ridge.config.json\ 涓昏瀛楁:
- \defaultWorkspace\ - 榛樿宸ヤ綔鐩綍
- \modelListUrl\ - Codex 妯″瀷鍒楄〃绔偣
- \pollTimeoutSeconds\ - Telegram 闀胯疆璇㈣秴鏃?寤鸿 20-30 绉?
- \llowedCwdRoots\ - 鍏佽鍒囨崲鐨勫伐浣滅洰褰曟牴璺緞鍒楄〃
### 鏁呴殰鎺掓煡
**缃戠粶杩炴帴閿欒** (\ECONNRESET\ / \TIMEOUT\)
- 杩欎簺鏄娇鐢ㄤ唬鐞嗚闂?Telegram API 鏃剁殑甯歌閿欒
- Bridge 浼氳嚜鍔ㄩ噸璇?涓嶅奖鍝嶆甯镐娇鐢?- 鍙互闄嶄綆 \pollTimeoutSeconds\ 鏉ュ噺灏戣秴鏃堕鐜?
**Codex 鍐欏叆鍐茬獊** (\lready has an active writer\)
- 鍚屼竴绾跨▼涓嶈兘鍚屾椂鏈夊涓啓鍏ユ搷浣?- 杩欐槸姝ｅ父鐨勪繚鎶ゆ満鍒?- 绛夊緟涓婁竴鏉℃秷鎭鐞嗗畬鎴愬悗鍐嶅彂閫佹柊娑堟伅
**鍚姩鏉冮檺閿欒**
- Codex daemon 蹇呴』浠庨潪绠＄悊鍛樻潈闄愮殑缁堢鍚姩
- 鍏抽棴绠＄悊鍛?PowerShell,浠ユ櫘閫氱敤鎴疯韩浠介噸鏂版墦寮€
### 璁稿彲璇?
鏈」鐩负绉佹湁椤圭洰,浠呬緵涓汉浣跨敤銆?
---
## English
### Features
**Basic Functions**
- Chat with Codex through Telegram
- Support text and image input
- Real-time Codex turn progress display
- Session history management and search
- Model and permission mode switching
**Session Management** (New)
- \/cwd\ - View or change working directory
- \/rename\ - Rename current session
- \/archive\ - Archive current session
- \/fork\ - Fork session to new topic
- \/compact\ - Compact session history
- \/effort\ - Set reasoning effort (low/medium/high/ultra)
**Enhanced Features**
- Auto-register Telegram command list (type \/\ to see all commands)
- Enhanced progress display (shows executing commands and file modifications)
- Auto-cleanup for input flow and approval timeouts
- Startup failure auto-retry (3 attempts with exponential backoff)
- Connection logging to \.runtime/bridge.log\
### Requirements
- Windows with Node.js 22.21 or newer
- Codex CLI installed and signed in
- Codex app-server daemon running under the same Windows account
- Telegram bot token from \@BotFather\
The Bridge uses Telegram long polling and a local Codex control socket. It does not open a public port.
On Windows, the start script reads the current user's proxy settings when \HTTP_PROXY\ and \HTTPS_PROXY\ are not set, and configures Node.js to use that proxy while keeping localhost traffic direct.
### First Connection
1. In Telegram, open \@BotFather\, run \/newbot\, and follow its prompts. Keep the token private.
2. In PowerShell, go to this project directory and save the token:
   \\\powershell
   .\scripts\save-token.ps1
   \\\
   Windows encrypts the token for the current account with DPAPI and stores it under \.runtime\.
3. Copy the configuration template:
   \\\powershell
   Copy-Item bridge.config.example.json bridge.config.json
   \\\
   Modify \ridge.config.json\ to set your workspace and allowed paths.
4. Install dependencies:
   \\\powershell
   npm install
   \\\
5. Start the Bridge:
   \\\powershell
   .\scripts\start.ps1
   \\\
   The terminal prints a one-time pairing code. It expires after 20 minutes.
6. Open your new bot in Telegram, press **Start**, then send \/pair YOUR_CODE\ using the code shown in PowerShell.
7. Send \/help\, then \/new\ to create a Codex session. Sending \/new Topic name\ creates a Telegram topic when private Topics are enabled.
The Bridge binds to the first Telegram user that successfully pairs. It ignores messages from other accounts and all group chats.
### Commands
- \/new [topic name]\ 鈥?Create a Codex session and, when available, a private Telegram topic
- \/history\ 鈥?Browse recent Codex sessions and resume one in the current topic
- \/search words\ 鈥?Search saved Codex session history
- \/open THREAD_ID\ 鈥?Resume a session by ID
- \/model\ 鈥?Choose from the local proxy's live \/v1/models\ response
- \/permission\ 鈥?Select read-only, project-write, or fully unrestricted access
- \/status\ 鈥?Show the current thread, model, workspace, and permission
- \/stop\ 鈥?Interrupt the active Codex turn
- \/cwd [path]\ 鈥?View or change working directory
- \/rename name\ 鈥?Rename current session
- \/archive\ 鈥?Archive current session
- \/fork [topic]\ 鈥?Fork session to new topic
- \/compact\ 鈥?Compact session history
- \/effort\ 鈥?Set reasoning effort level
Send text or an image to start a Codex turn.
The default workspace and model-list endpoint are in \ridge.config.json\. The bot checks the proxy model list again before applying a model. Image downloads are limited to 20 MB and stored under \.runtime/attachments\.
### Private Topics
Enable Topics for the bot's private chat in \@BotFather\ if you want one Telegram topic per Codex session. The Bridge still works without Topics, but \/new\ then switches the single private chat to the new session; earlier sessions remain available through \/history\.
### Optional Automatic Start
After pairing the bot, install a per-user Windows logon task:
\\\powershell
.\scripts\install-autostart.ps1
\\\
Remove it with:
\\\powershell
.\scripts\remove-autostart.ps1
\\\
The task runs after this Windows account signs in. Keep the computer awake while plugged in if you need the bot to be continuously reachable; sleep suspends both Telegram polling and local Codex access.
### Data and Security
- \.runtime\ is excluded from Git. The bot token is encrypted with Windows DPAPI for the current account.
- Pairing state, Telegram update offset, topic-to-thread mappings, and downloaded images are stored locally in \.runtime\.
- The Codex child process does not inherit \TELEGRAM_BOT_TOKEN\.
- New threads start with project-write access and \on-request\ approvals. Fully unrestricted access requires a second confirmation in Telegram.
- The app-server protocol is experimental and may change with Codex CLI updates. Rebuild the Bridge after CLI updates.
- If Telegram reports that a webhook is configured, this bot token is already used by a webhook-based service. Remove that webhook or create a fresh bot token before starting this long-polling Bridge.
### Configuration
Main fields in \ridge.config.json\:
- \defaultWorkspace\ - Default working directory
- \modelListUrl\ - Codex model list endpoint
- \pollTimeoutSeconds\ - Telegram long polling timeout (recommended 20-30 seconds)
- \llowedCwdRoots\ - List of allowed working directory root paths
### Troubleshooting
**Network Connection Errors** (\ECONNRESET\ / \TIMEOUT\)
- Common errors when using a proxy to access Telegram API
- Bridge auto-retries, does not affect normal usage
- Lower \pollTimeoutSeconds\ to reduce timeout frequency
**Codex Write Conflict** (\lready has an active writer\)
- Same thread cannot have multiple concurrent write operations
- This is a normal protection mechanism
- Wait for previous message to complete before sending new one
**Startup Permission Error**
- Codex daemon must be started from a non-elevated terminal
- Close administrator PowerShell and reopen as regular user
### License
This project is private and for personal use only.
