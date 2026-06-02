import { Telegraf, Markup } from 'telegraf';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!BOT_TOKEN || !OWNER_ID || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error("❌ Error: Konfigurasi di file .env belum lengkap!");
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Menyimpan status/state admin saat sedang input data
const adminStates = {};

function isPrivateChat(ctx) {
    return ctx.chat && ctx.chat.type === 'private';
}

// ========================================================
// UTILITY FUNCTIONS
// ========================================================
async function checkMembership(ctx, userId, channelId, groupId) {
    let joinedChannel = false;
    let joinedGroup = false;

    if (channelId === '-100xxxxx' || groupId === '-100xxxxx') {
        return { channel: true, group: true, all: true };
    }

    // Function helper untuk retry dengan delay (handle Telegram API delay saat user baru join)
    async function checkChatMemberWithRetry(telegramCtx, chatId, uid, retries = 2) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const member = await telegramCtx.telegram.getChatMember(chatId, uid);
                if (['creator', 'administrator', 'member', 'restricted'].includes(member.status)) {
                    return true;
                }
                return false;
            } catch (err) {
                if (attempt < retries) {
                    // Tunggu 1 detik sebelum retry agar Telegram API punya waktu update status
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } else {
                    console.error(`⚠️ Gagal cek status chat member setelah ${retries + 1} percobaan:`, err.message);
                    return false;
                }
            }
        }
        return false;
    }

    // Cek Channel dengan retry
    joinedChannel = await checkChatMemberWithRetry(ctx, channelId, userId, 2);

    // Cek Grup dengan retry
    joinedGroup = await checkChatMemberWithRetry(ctx, groupId, userId, 2);

    return { channel: joinedChannel, group: joinedGroup, all: joinedChannel && joinedGroup };
}

function generateJoinKeyboard(settings, checkStatus) {
    const buttons = [];
    const cleanChannelId = settings.channel_id.replace('-100', '');
    const cleanGroupId = settings.group_id.replace('-100', '');

    const channelLink = settings.channel_id !== '-1003979281878' ? `https://t.me/c/${cleanChannelId}/1` : 'https://t.me/persekentutanfess';
    const groupLink = settings.group_id !== '-1003982415611' ? `https://t.me/c/${cleanGroupId}/1` : 'https://t.me/+ptJEewUHrG03YmI1';

    if (!checkStatus.channel) buttons.push([Markup.button.url('📢 Join Channel Kentutmenfess', channelLink)]);
    if (!checkStatus.group) buttons.push([Markup.button.url('💬 Join Grup Persekentutan', groupLink)]);

    buttons.push([Markup.button.callback('🔄 Coba Lagi', 'check_sub')]);
    return Markup.inlineKeyboard(buttons);
}

async function logAdminAction(adminId, adminNickname, action, targetId = null) {
    await supabase.from('admin_logs').insert({
        admin_id: adminId,
        admin_nickname: adminNickname,
        action: action,
        target_id: targetId
    });
}

// ========================================================
// HANDLER: /start UTAMA
// ========================================================
async function handleStartLogic(ctx, isCallback = false) {
    const from = ctx.from;
    const userId = from.id;
    const username = from.username ? `@${from.username}` : 'Tidak ada';
    const nickname = from.first_name + (from.last_name ? ` ${from.last_name}` : '');

    try {
        const { data: settings } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
        if (!settings) return ctx.reply("❌ Gagal mengambil konfigurasi bot dari database.");

        const { data: userCheck } = await supabase.from('users').select('*').eq('telegram_id', userId).single();
        const isCurrentlyAdmin = userCheck?.is_admin || userId === OWNER_ID;

        if (!settings.is_active && !isCurrentlyAdmin) {
            return ctx.reply("⚠️ Menfess sedang dimatikan, harap hubungi @arikamukunaon");
        }

        const defText = settings.default_text_quota ?? 15;
        const defMedia = settings.default_media_quota ?? 5;

        const { data: userDb } = await supabase
            .from('users')
            .upsert({
                telegram_id: userId,
                username: username,
                nickname: nickname,
                text_quota: userCheck ? userCheck.text_quota : defText,
                media_quota: userCheck ? userCheck.media_quota : defMedia
            }, { onConflict: 'telegram_id' })
            .select().single();

        if (userDb && userDb.is_banned) {
            return ctx.reply("❌ Kamu telah di-ban seumur hidup dari bot ini karena melanggar aturan!");
        }

        if (!isCurrentlyAdmin) {
            const check = await checkMembership(ctx, userId, settings.channel_id, settings.group_id);
            if (!check.all) {
                const msgTeks = !check.channel && !check.group ? settings.msg_not_joined : settings.msg_half_joined;
                if (isCallback) await ctx.answerCbQuery("❌ Kamu belum bergabung di semua tujuan wajib!", { show_alert: true });
                return ctx.reply(`⚠️ Akses Terkunci!\n\n${msgTeks}`, generateJoinKeyboard(settings, check));
            }
        }

        const currentTextQuota = userDb ? userDb.text_quota : defText;
        const currentMediaQuota = userDb ? userDb.media_quota : defMedia;

        const welcomeText = `${settings.msg_welcome}\n\n` +
            `*Kuota harian lu:*\n` +
            `📝 Teks doang : ${currentTextQuota}\n` +
            `🖼️ Media : ${currentMediaQuota}\n\n` +
            `_Yu kirim cihuyyyyyyyyyyyyyyyy_`;

        if (isCallback) await ctx.answerCbQuery("Sukses Terverifikasi! 🎉");

        return ctx.replyWithMarkdown(welcomeText, Markup.inlineKeyboard([
            [Markup.button.callback('👤 Profile', 'view_profile'), Markup.button.callback('📜 Aturan', 'view_rules')]
        ]));

    } catch (error) { console.error(error); }
}

bot.start(async (ctx) => {
    if (!isPrivateChat(ctx)) {
        return ctx.reply('⚠️ Bot ini hanya bekerja di chat pribadi. Buka chat langsung dengan bot dan ketik /start di sana.');
    }
    await handleStartLogic(ctx, false);
});

bot.action('check_sub', async (ctx) => { try { await ctx.deleteMessage(); } catch (e) { } await handleStartLogic(ctx, true); });

bot.action('view_profile', async (ctx) => {
    try {
        const { data: userDb } = await supabase.from('users').select('text_quota, media_quota').eq('telegram_id', ctx.from.id).single();
        await ctx.answerCbQuery("Membuka Profil... 👤");
        const profileText = `*👤 DETAIL AKUN LU*\n\n` +
            `🆔 *ID Telegram :* \`${ctx.from.id}\`\n` +
            `👤 *Username :* ${ctx.from.username ? `@${ctx.from.username}` : 'Tidak ada'}\n` +
            `🏷️ *Nickname :* ${ctx.from.first_name}\n\n` +
            `*📊 INFORMASI LU:* \n` +
            `📝 *Teks :* ${userDb?.text_quota}\n` +
            `🖼️ *Media :* ${userDb?.media_quota}\n\n` +
            `_*Mau nambah kuota / menfess tak terbatas? Hubungi @arikamukunaon*_`;
        await ctx.replyWithMarkdown(profileText, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'back_to_start')]]));
    } catch (err) { console.error(err); }
});

bot.action('view_rules', async (ctx) => {
    try {
        await ctx.answerCbQuery("Membuka Aturan... 📜");
        const { data: settings } = await supabase.from('bot_settings').select('msg_rules').eq('id', 1).single();
        const rulesText = settings?.msg_rules || `*📜 RULES BOT MENFESS*\n\n*🚫 GABOLEH KIRIM:*\n1. Porno / NSFW\n2. Link Judi / Phishing / Iklan\n3. Rasisme / SARA\n4. LGBTQ+\n\n🔥 *MELANGGAR = BAN SEUMUR HIDUP!*`;
        await ctx.replyWithMarkdown(rulesText, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'back_to_start')]]));
    } catch (err) { console.error(err); }
});

bot.action('back_to_start', async (ctx) => {
    try { await ctx.answerCbQuery(); try { await ctx.deleteMessage(); } catch (e) { } await handleStartLogic(ctx, false); } catch (err) { console.error(err); }
});

// ========================================================
// LOGIKA: /setting UTAMA (OWNER VS ADMIN)
// ========================================================
async function renderSettingsMenu(ctx, userId) {
    const { data: userDb } = await supabase.from('users').select('*').eq('telegram_id', userId).single();
    const isOwner = userId === OWNER_ID;
    const isAdmin = userDb?.is_admin || isOwner;

    if (!isAdmin) return ctx.reply("❌ Kamu tidak memiliki akses ke perintah ini!");

    const { data: settings } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
    const statusBot = settings?.is_active ? "🟢 ON (Aktif)" : "🔴 OFF (Mati)";

    let menuMsg = `🛠️ *DASHBOARD CONTROL BOT MENFESS*\n` +
        `👑 *Role Lu:* ${isOwner ? 'Owner Utama' : 'Admin Operasional'}\n` +
        `⚡ *Status Bot:* ${statusBot}\n\n` +
        `⚙️ *Kuota Awal User Baru saat ini:* \n` +
        `📝 Teks: ${settings?.default_text_quota ?? 15} | 🖼️ Media: ${settings?.default_media_quota ?? 5}\n\n` +
        `Silakan pilih menu pengaturan di bawah ini:`;

    const buttons = [];

    // JIKA YANG AKSES ADALAH ADMIN BIASA
    if (!isOwner && isAdmin) {
        buttons.push([Markup.button.callback('🔍 Cek & Atur Kuota User', 'adm_cek_kuota')]);
        buttons.push([Markup.button.callback(settings?.is_active ? '🛑 Matikan Bot (OFF)' : '✅ Aktifkan Bot (ON)', 'adm_toggle_bot')]);
        buttons.push([Markup.button.callback('⚙️ Atur Kuota Awal', 'adm_set_kuota_awal')]);
        buttons.push([Markup.button.callback('🚫 Ban User', 'adm_ban_user')]);
        buttons.push([Markup.button.callback('📝 Edit Teks Pesan / Rules', 'adm_menu_teks')]);
    }
    // JIKA YANG AKSES ADALAH OWNER UTAMA
    else if (isOwner) {
        buttons.push([Markup.button.callback('📈 Riwayat Menfess', 'adm_riwayat_menfess')]);
        buttons.push([Markup.button.callback('🔍 Cek & Atur Kuota User', 'adm_cek_kuota')]);
        buttons.push([Markup.button.callback(settings?.is_active ? '🛑 Matikan Bot (OFF)' : '✅ Aktifkan Bot (ON)', 'adm_toggle_bot')]);
        buttons.push([Markup.button.callback('⚙️ Atur Kuota Awal', 'adm_set_kuota_awal')]);
        buttons.push([Markup.button.callback('🚫 Ban User', 'adm_ban_user'), Markup.button.callback('🔓 Unban User', 'adm_unban_user')]);
        buttons.push([Markup.button.callback('🔑 Beri Akses Hapus', 'adm_beri_akses_hapus'), Markup.button.callback('🔒 Cabut Akses Hapus', 'adm_cabut_akses_hapus')]);
        buttons.push([Markup.button.callback('📝 Edit Teks Pesan / Rules', 'adm_menu_teks')]);
        buttons.push([Markup.button.callback('👤 Tambah Admin Baru', 'adm_tambah_admin'), Markup.button.callback('❌ Hapus Admin', 'adm_hapus_admin')]);
        buttons.push([Markup.button.callback('📜 Log Kegiatan Admin (24 Jam)', 'adm_log_kegiatan')]);
        buttons.push([Markup.button.callback('📢 Kirim Pengumuman (Broadcast)', 'adm_broadcast_menu')]);
    }

    buttons.push([Markup.button.callback('❌ Tutup Menu', 'adm_close')]);

    if (ctx.callbackQuery) {
        try { await ctx.editMessageText(menuMsg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }); } catch (e) {
            await ctx.replyWithMarkdown(menuMsg, Markup.inlineKeyboard(buttons));
        }
    } else {
        await ctx.replyWithMarkdown(menuMsg, Markup.inlineKeyboard(buttons));
    }
}

bot.command('setting', (ctx) => renderSettingsMenu(ctx, ctx.from.id));

bot.action('adm_close', async (ctx) => { try { await ctx.deleteMessage(); } catch (e) { } });
bot.action('adm_back_main', async (ctx) => { await renderSettingsMenu(ctx, ctx.from.id); });

bot.action('adm_riwayat_menfess', async (ctx) => {
    if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery("❌ Menu khusus Owner!", { show_alert: true });
    const { count: totalUser } = await supabase.from('users').select('*', { count: 'exact', head: true });
    const { count: totalBanned } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('is_banned', true);
    const statsMsg = `📊 *STATISTIK & RIWAYAT BOT MENFESS*\n\n👥 Total User Terdaftar: *${totalUser || 0}* orang\n🚫 Total User Di-ban: *${totalBanned || 0}* orang\n\n_Catatan: Riwayat aktivitas menfess terkirim real-time ke log admin pribadi owner._`;
    await ctx.replyWithMarkdown(statsMsg, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'adm_back_main')]]));
});

// ========================================================
// LOGIKA: INTERAKTIF CEK, TAMBAH, & KURANG KUOTA
// ========================================================
bot.action('adm_cek_kuota', async (ctx) => {
    adminStates[ctx.from.id] = { mode: 'WAITING_USER_ID_CEK' };
    await ctx.reply("🔍 Masukkan ID Telegram user yang ingin dicek kuotanya:\n\n_(Ketik /cancel jika ingin membatalkan)_");
});

bot.action(['action_tambah', 'action_kurang'], async (ctx) => {
    const actionType = ctx.callbackQuery.data === 'action_tambah' ? 'TAMBAH' : 'KURANG';
    const state = adminStates[ctx.from.id];

    if (!state?.targetId) return ctx.answerCbQuery("❌ Sesi kedaluwarsa, silakan ulang /setting", { show_alert: true });

    state.actionType = actionType;

    await ctx.editMessageText(`Mau mengubah kuota jenis apa untuk ID \`${state.targetId}\`?`, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('📝 Kuota Teks', 'type_teks'), Markup.button.callback('🖼️ Kuota Media', 'type_media')]
        ]).reply_markup
    });
});

bot.action(['type_teks', 'type_media'], async (ctx) => {
    const quotaType = ctx.callbackQuery.data === 'type_teks' ? 'text_quota' : 'media_quota';
    const state = adminStates[ctx.from.id];

    if (!state?.targetId) return ctx.answerCbQuery("❌ Sesi kedaluwarsa, silakan ulang /setting", { show_alert: true });

    state.mode = 'WAITING_FINAL_NOMINAL';
    state.quotaType = quotaType;

    await ctx.reply(`📥 Masukkan **jumlah angka** kuota yang ingin di-${state.actionType.toLowerCase()}:\nContoh: \`5\``);
});

// ========================================================
// LOGIKA: MANAJEMEN HAK AKSES HAPUS POSTINGAN USER
// ========================================================
bot.action('adm_beri_akses_hapus', async (ctx) => {
    if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery("❌ Menu khusus Owner!", { show_alert: true });
    adminStates[ctx.from.id] = { mode: 'WAITING_GIVE_DELETE_ACCESS' };
    await ctx.reply("📥 Masukkan **ID Telegram** user yang ingin diberi akses hapus postingan:\n\n_(Ketik /cancel untuk membatalkan)_");
});

bot.action('adm_cabut_akses_hapus', async (ctx) => {
    if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery("❌ Menu khusus Owner!", { show_alert: true });
    adminStates[ctx.from.id] = { mode: 'WAITING_REVOKE_DELETE_ACCESS' };
    await ctx.reply("📥 Masukkan **ID Telegram** user yang ingin dicabut akses hapus postingannya:\n\n_(Ketik /cancel untuk membatalkan)_");
});

// ========================================================
// ACTION HANDLER: LAINNYA
// ========================================================
bot.action('adm_set_kuota_awal', async (ctx) => {
    adminStates[ctx.from.id] = { mode: 'WAITING_DEFAULT_QUOTA' };
    await ctx.reply("⚙️ **[SETTING KUOTA AWAL USER BARU]**\nSilakan masukkan rancangan kuota awal baru untuk teks dan media.\nFormat: `KUOTA_TEKS KUOTA_MEDIA`\nContoh: `10 3`\n\n_(Ketik /cancel jika ingin membatalkan)_");
});

bot.action('adm_toggle_bot', async (ctx) => {
    const { data: settings } = await supabase.from('bot_settings').select('is_active').eq('id', 1).single();
    const newStatus = !settings.is_active;
    await supabase.from('bot_settings').update({ is_active: newStatus }).eq('id', 1);
    await logAdminAction(ctx.from.id, ctx.from.first_name, `Mengubah status operasional bot menjadi ${newStatus ? 'ON' : 'OFF'}`);
    await ctx.answerCbQuery(`Bot berhasil diubah menjadi ${newStatus ? 'AKTIF' : 'NON-AKTIF'}!`, { show_alert: true });
    await renderSettingsMenu(ctx, ctx.from.id);
});

bot.action('adm_tambah_admin', async (ctx) => {
    if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery("❌ Menu khusus Owner!", { show_alert: true });
    adminStates[ctx.from.id] = { mode: 'WAITING_ADD_ADMIN' };
    await ctx.reply("📥 Silakan kirimkan **ID Telegram** calon admin baru:\n\n_(Ketik /cancel untuk membatalkan)_");
});

bot.action('adm_log_kegiatan', async (ctx) => {
    if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery("❌ Menu khusus Owner!", { show_alert: true });
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: logs } = await supabase.from('admin_logs').select('*').gte('created_at', oneDayAgo).order('created_at', { ascending: false });
    let logMsg = `📜 *LOG KEGIATAN ADMIN (24 JAM TERAKHIR)*\n\n`;
    if (!logs || logs.length === 0) { logMsg += `_Belum ada aktivitas admin apa pun dalam 24 jam terakhir._`; } else {
        logs.forEach((log, index) => {
            const waktu = new Date(log.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
            logMsg += `${index + 1}. [${waktu}] *${log.admin_nickname}* -> ${log.action} ${log.target_id ? `(Target: \`${log.target_id}\`)` : ''}\n`;
        });
    }
    await ctx.replyWithMarkdown(logMsg, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'adm_back_main')]]));
});

bot.action('adm_hapus_admin', async (ctx) => {
    if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery("❌ Menu khusus Owner!", { show_alert: true });
    adminStates[ctx.from.id] = { mode: 'WAITING_REMOVE_ADMIN' };
    await ctx.reply("📥 Silakan kirimkan **ID Telegram** admin yang ingin dicopot jabatannya:\n\n_(Ketik /cancel untuk membatalkan)_");
});

bot.action('adm_menu_teks', async (ctx) => {
    const textMenuMsg = `📝 *PILIH KUSTOMISASI TEKS PESAN BOT*\n\nSilakan pilih komponen pesan teks yang ingin kamu modifikasi isinya:`;
    const buttons = [
        [Markup.button.callback('❌ Pesan Belum Join', 'edit_msg_not_joined')],
        [Markup.button.callback('⚠️ Pesan Baru Join Salah Satu', 'edit_msg_half_joined')],
        [Markup.button.callback('✅ Pesan Sukses Join (/start)', 'edit_msg_welcome')],
        [Markup.button.callback('📜 Edit Teks Rules Bot', 'edit_msg_rules')],
        [Markup.button.callback('⬅️ Kembali ke Utama', 'adm_back_main')]
    ];
    await ctx.editMessageText(textMenuMsg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
});

const subTextActions = [
    { act: 'edit_msg_not_joined', mode: 'WAITING_TEXT_NOT_JOINED', title: 'Belum Join Sama Sekali' },
    { act: 'edit_msg_half_joined', mode: 'WAITING_TEXT_HALF_JOINED', title: 'Baru Join Salah Satu' },
    { act: 'edit_msg_welcome', mode: 'WAITING_TEXT_WELCOME', title: 'Sukses Masuk (/start)' },
    { act: 'edit_msg_rules', mode: 'WAITING_TEXT_RULES', title: 'Peraturan (Rules) Bot' }
];
subTextActions.forEach(item => {
    bot.action(item.act, async (ctx) => {
        adminStates[ctx.from.id] = { mode: item.mode };
        await ctx.reply(`📝 Silakan kirimkan rancangan teks kustom terbaru untuk bagian *${item.title}*:\n\n_(Ketik /cancel untuk membatalkan)_`);
    });
});

bot.action('adm_ban_user', async (ctx) => {
    adminStates[ctx.from.id] = { mode: 'WAITING_BAN_INPUT' };
    await ctx.reply("📥 Silakan kirimkan **ID Telegram** user nakal yang ingin di-ban seumur hidup:\n\n_(Ketik /cancel untuk membatalkan)_");
});

bot.action('adm_unban_user', async (ctx) => {
    if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery("❌ Menu khusus Owner!", { show_alert: true });
    adminStates[ctx.from.id] = { mode: 'WAITING_UNBAN_INPUT' };
    await ctx.reply("📥 Silakan kirimkan **ID Telegram** user yang ingin di-unban:\n\n_(Ketik /cancel untuk membatalkan)_");
});

// ACTION HANDLER: EKSEKUSI HAPUS PESAN DI CHANNEL (DENGAN SECURITY CHECK DB)
// GANTI HANDLER DEL_POST LAMA KAMU DENGAN INI:
bot.action(/^del_post_(\d+)$/, async (ctx) => {
    const messageIdInChannel = parseInt(ctx.match[1]);
    const userId = ctx.from.id;

    try {
        const { data: userDb } = await supabase.from('users').select('*').eq('telegram_id', userId).single();
        const isOwnerOrAdmin = (userId === OWNER_ID || userDb?.is_admin);
        const hasAccess = isOwnerOrAdmin || userDb?.can_delete_post;

        // JIKA USER BELUM BELI / BELUM PUNYA AKSES:
        if (!hasAccess) {
            return ctx.answerCbQuery(
                "⚠️ Fitur ini premium! Lu harus punya hak akses hapus dulu. Hubungi @arikamukunaon untuk upgrade!",
                { show_alert: true }
            );
        }

        // JIKA PUNYA AKSES (Owner, Admin, atau User Premium):
        const { data: settings } = await supabase.from('bot_settings').select('channel_id').eq('id', 1).single();
        if (!settings || !settings.channel_id) return ctx.answerCbQuery("❌ Gagal mengambil ID Channel tujuan.", { show_alert: true });

        // Eksekusi hapus kiriman menfess di channel
        await ctx.telegram.deleteMessage(settings.channel_id, messageIdInChannel);

        // Edit notifikasi sukses di room chat user
        await ctx.editMessageText("🗑️ *Postingan menfess ini telah berhasil dihapus dari channel!*", { parse_mode: 'Markdown' });
        await ctx.answerCbQuery("Postingan berhasil ditarik/dihapus! 🎉");

        await logAdminAction(userId, ctx.from.first_name, `Menghapus postingan menfess (Msg ID: ${messageIdInChannel}) di channel`);

    } catch (error) {
        console.error("Gagal menghapus pesan:", error.message);
        await ctx.answerCbQuery("❌ Gagal menghapus postingan! Kemungkinan pesan sudah terlalu lama (>48 jam) atau sudah dihapus manual.", { show_alert: true });
    }
});

bot.action('adm_broadcast_menu', async (ctx) => {
    if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery("❌ Menu khusus Owner!", { show_alert: true });
    adminStates[ctx.from.id] = { mode: 'WAITING_BROADCAST_TEXT' };
    await ctx.reply("📢 **[MENU ANNOUNCEMENT / BROADCAST]**\n\nSilakan ketik atau kirim pesan pengumuman yang ingin disebarkan ke seluruh pengguna bot.\n\n_Catatan: Mendukung format Markdown (Teks tebal, miring, link, dll)._\n\n_(Ketik /cancel untuk membatalkan)_");
});


bot.command('cancel', (ctx) => {
    if (adminStates[ctx.from.id]) { delete adminStates[ctx.from.id]; return ctx.reply("🔄 Pengisian data atau perintah dibatalkan."); }
    ctx.reply("Tidak ada perintah aktif yang sedang berjalan.");
});

// ========================================================
// LOGIKA KOLEKTOR INPUT ADM & PROSES PENERIMAAN MENFESS
// ========================================================
bot.on(['text', 'photo', 'video', 'animation'], async (ctx) => {
    if (!isPrivateChat(ctx)) return;

    const userId = ctx.from.id;
    const username = ctx.from.username ? `@${ctx.from.username}` : 'Tidak ada';
    const nickname = ctx.from.first_name || 'Tidak ada';

    // INTERSEPSI KODE ADM / OWNER INPUT STATE
    if (ctx.message.text && adminStates[userId]) {
        const state = adminStates[userId];
        const input = ctx.message.text.trim();

        if (input.startsWith('/cancel')) { delete adminStates[userId]; return ctx.reply("🔄 Operasi berhasil dibatalkan."); }

        try {
            if (state.mode === 'WAITING_USER_ID_CEK') {
                const targetId = parseInt(input);
                if (isNaN(targetId)) return ctx.reply("⚠️ Mohon kirimkan ID berupa angka murni!");

                const { data: targetUser } = await supabase.from('users').select('*').eq('telegram_id', targetId).single();
                if (!targetUser) return ctx.reply("❌ User ID tersebut tidak ditemukan di database / belum pernah klik /start.");

                adminStates[userId] = { mode: 'MANAGE_USER_QUOTA', targetId: targetId };

                const infoTeks = `👤 *PROFIL KUOTA USER*\n\n` +
                    `🆔 ID: \`${targetId}\`\n` +
                    `📝 Kuota Teks: *${targetUser.text_quota}*\n` +
                    `🖼️ Kuota Media: *${targetUser.media_quota}*\n` +
                    `🔑 Akses Hapus Post: *${targetUser.can_delete_post ? 'Aktif ✅' : 'Mati ❌'}*\n\n` +
                    `Silakan pilih tindakan di bawah ini:`;

                return ctx.replyWithMarkdown(infoTeks, Markup.inlineKeyboard([
                    [Markup.button.callback('➕ Tambahkan Kuota', 'action_tambah'), Markup.button.callback('➖ Kurangi Kuota', 'action_kurang')],
                    [Markup.button.callback('❌ Tutup', 'adm_close')]
                ]));
            }

            if (state.mode === 'WAITING_FINAL_NOMINAL') {
                const nominal = parseInt(input);
                if (isNaN(nominal) || nominal <= 0) return ctx.reply("⚠️ Masukkan angka murni yang valid dan lebih dari 0!");

                const targetId = state.targetId;
                const { data: targetUser } = await supabase.from('users').select('*').eq('telegram_id', targetId).single();
                if (!targetUser) return ctx.reply("❌ Data user mendadak hilang atau tidak ditemukan.");

                let currentQuota = targetUser[state.quotaType];
                let newQuota = state.actionType === 'TAMBAH' ? currentQuota + nominal : Math.max(0, currentQuota - nominal);

                await supabase.from('users').update({ [state.quotaType]: newQuota }).eq('telegram_id', targetId);

                const namaKolom = state.quotaType === 'text_quota' ? 'Teks' : 'Media';
                await logAdminAction(userId, nickname, `${state.actionType === 'TAMBAH' ? 'Menambah' : 'Mengurangi'} kuota [${namaKolom}] sebanyak ${nominal}`, targetId);

                delete adminStates[userId];
                return ctx.reply(`✅ Berhasil! Kuota *${namaKolom}* user \`${targetId}\` sekarang diubah menjadi: *${newQuota}*`);
            }

            // EKSEKUSI MEMBERI AKSES HAPUS POST (OWNER)
            if (state.mode === 'WAITING_GIVE_DELETE_ACCESS') {
                const targetId = parseInt(input);
                if (isNaN(targetId)) return ctx.reply("⚠️ Mohon kirimkan ID berupa angka murni!");

                await supabase.from('users').upsert({ telegram_id: targetId, can_delete_post: true }, { onConflict: 'telegram_id' });
                await logAdminAction(userId, nickname, `Memberikan hak akses hapus postingan`, targetId);
                delete adminStates[userId];

                try { await ctx.telegram.sendMessage(targetId, "🔑 *Pemberitahuan:* Anda telah diberikan hak akses khusus oleh Owner untuk menghapus postingan menfess sendiri setelah terkirim!"); } catch (e) { }
                return ctx.reply(`✅ Sukses memberikan hak akses hapus postingan ke ID user: \`${targetId}\``);
            }

            // EKSEKUSI MENCABUT AKSES HAPUS POST (OWNER)
            if (state.mode === 'WAITING_REVOKE_DELETE_ACCESS') {
                const targetId = parseInt(input);
                if (isNaN(targetId)) return ctx.reply("⚠️ Mohon kirimkan ID berupa angka murni!");

                await supabase.from('users').update({ can_delete_post: false }).eq('telegram_id', targetId);
                await logAdminAction(userId, nickname, `Mencabut hak akses hapus postingan`, targetId);
                delete adminStates[userId];

                try { await ctx.telegram.sendMessage(targetId, "🔒 *Pemberitahuan:* Hak akses khusus Anda untuk menghapus postingan menfess telah dicabut oleh Owner."); } catch (e) { }
                return ctx.reply(`✅ Sukses mencabut hak akses hapus postingan dari ID user: \`${targetId}\``);
            }

            if (state.mode === 'WAITING_DEFAULT_QUOTA') {
                const parts = input.split(' ');
                if (parts.length < 2) return ctx.reply("⚠️ Format salah! Gunakan: `KUOTA_TEKS KUOTA_MEDIA` (Contoh: `10 3`)");
                const defaultText = parseInt(parts[0]);
                const defaultMedia = parseInt(parts[1]);

                if (isNaN(defaultText) || isNaN(defaultMedia)) return ctx.reply("⚠️ Mohon kirimkan data angka murni!");

                await supabase.from('bot_settings').update({ default_text_quota: defaultText, default_media_quota: defaultMedia }).eq('id', 1);
                await logAdminAction(userId, nickname, `Mengubah kuota awal default baru menjadi -> Teks: ${defaultText}, Media: ${defaultMedia}`);
                delete adminStates[userId];
                return ctx.reply(`✅ Sukses! Kuota awal default untuk user baru berhasil diubah menjadi:\n📝 Teks: ${defaultText}\n🖼️ Media: ${defaultMedia}`);
            }

            if (state.mode === 'WAITING_ADD_ADMIN') {
                const targetId = parseInt(input);
                if (isNaN(targetId)) return ctx.reply("⚠️ Mohon kirimkan ID berupa angka murni!");

                const { data: targetUser } = await supabase.from('users').select('*').eq('telegram_id', targetId).single();
                if (!targetUser) return ctx.reply("❌ User tersebut belum terdaftar. Suruh user klik /start di bot terlebih dahulu!");

                await supabase.from('users').update({ is_admin: true }).eq('telegram_id', targetId);
                await logAdminAction(userId, nickname, `Mengangkat user sebagai admin baru`, targetId);
                delete adminStates[userId];

                try {
                    await ctx.telegram.sendMessage(targetId, "🎉 *Selamat! Anda telah resmi diangkat menjadi Admin Bot Menfess oleh Owner Utama.*\n\nSekarang Anda bisa mengetik perintah /setting untuk mengakses dashboard admin operasional! 😎", { parse_mode: 'Markdown' });
                } catch (errNotif) { console.error(errNotif.message); }

                return ctx.reply(`✅ Sukses! User dengan ID \`${targetId}\` resmi diangkat menjadi Admin baru.`);
            }

            if (state.mode === 'WAITING_REMOVE_ADMIN') {
                const targetId = parseInt(input);
                if (isNaN(targetId)) return ctx.reply("⚠️ Mohon kirimkan ID berupa angka murni!");

                const { data: targetUser } = await supabase.from('users').select('*').eq('telegram_id', targetId).single();
                if (!targetUser || !targetUser.is_admin) return ctx.reply("❌ User tersebut memang bukan admin.");

                await supabase.from('users').update({ is_admin: false }).eq('telegram_id', targetId);
                await logAdminAction(userId, nickname, `Mencopot jabatan admin`, targetId);
                delete adminStates[userId];

                try { await ctx.telegram.sendMessage(targetId, "⚠️ *Pemberitahuan:* Jabatan admin Anda pada Bot Menfess telah dicopot oleh Owner Utama.", { parse_mode: 'Markdown' }); } catch (e) { }
                return ctx.reply(`✅ Sukses! Jabatan admin dari ID \`${targetId}\` resmi dicopot.`);
            }

            if (state.mode === 'WAITING_BAN_INPUT') {
                const targetId = parseInt(input);
                if (isNaN(targetId)) return ctx.reply("⚠️ Mohon kirimkan ID berupa angka murni!");

                if (targetId === OWNER_ID) {
                    delete adminStates[userId];
                    return ctx.reply("❌ Operasi Ditolak! Lu kagak bisa nge-ban Owner Utama bot lah kocak wkwk. 🥶");
                }

                await supabase.from('users').upsert({ telegram_id: targetId, is_banned: true }, { onConflict: 'telegram_id' });
                await logAdminAction(userId, nickname, `Melakukan Ban Seumur Hidup`, targetId);
                delete adminStates[userId];
                return ctx.reply(`✅ ID \`${targetId}\` berhasil di-ban seumur hidup dari sistem menfess!`);
            }

            if (state.mode === 'WAITING_UNBAN_INPUT') {
                const targetId = parseInt(input);
                if (isNaN(targetId)) return ctx.reply("⚠️ Mohon kirimkan ID berupa angka murni!");

                const { data: targetUser } = await supabase.from('users').select('is_banned').eq('telegram_id', targetId).single();
                if (!targetUser || !targetUser.is_banned) return ctx.reply(`⚠️ ID \`${targetId}\` statusnya memang tidak sedang di-ban!`);

                await supabase.from('users').update({ is_banned: false }).eq('telegram_id', targetId);
                await logAdminAction(userId, nickname, `Melakukan Unban Akses`, targetId);
                delete adminStates[userId];
                return ctx.reply(`✅ Berhasil meng-unban ID \`${targetId}\`! Akses dia pulih.`);
            }

            if (state.mode === 'WAITING_BROADCAST_TEXT') {
                // Beri tahu owner kalau proses broadcast sedang berjalan
                const statusMsg = await ctx.reply("⏳ Sedang memproses dan mengirimkan pengumuman ke seluruh user, mohon tunggu...");

                try {
                    // 1. Ambil semua data telegram_id dari database Supabase
                    const { data: allUsers, error } = await supabase.from('users').select('telegram_id');

                    if (error || !allUsers || allUsers.length === 0) {
                        return ctx.reply("❌ Gagal mengambil data user dari database atau user masih kosong.");
                    }

                    let suksesCount = 0;
                    let gagalCount = 0;

                    // 2. Lakukan looping untuk mengirim pesan ke setiap user
                    for (const user of allUsers) {
                        // Lewati jika ID user tidak valid atau bernilai 0
                        if (!user.telegram_id) continue;

                        try {
                            // Kirim pesan broadcast menggunakan text input dari owner
                            await ctx.telegram.sendMessage(user.telegram_id, input, { parse_mode: 'Markdown' });
                            suksesCount++;
                        } catch (errSend) {
                            // Gagal biasanya terjadi jika user memblokir bot kamu
                            gagalCount++;
                        }
                    }

                    // 3. Catat aktivitas owner ke log admin
                    await logAdminAction(userId, nickname, `Mengirimkan broadcast pengumuman ke ${suksesCount} user`);

                    // Hapus state admin setelah selesai
                    delete adminStates[userId];

                    // 4. Berikan laporan akhir ke owner
                    try { await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) { }
                    return ctx.reply(`✅ *Broadcast Selesai Dikirim!*\n\n🎉 Berhasil terkirim: *${suksesCount}* user\n❌ Gagal/Bot Diblokir: *${gagalCount}* user`);

                } catch (err) {
                    console.error("Error saat broadcast:", err.message);
                    return ctx.reply("❌ Terjadi kesalahan sistem saat memproses broadcast.");
                }
            }

            const textFieldsMap = {
                'WAITING_TEXT_NOT_JOINED': 'msg_not_joined',
                'WAITING_TEXT_HALF_JOINED': 'msg_half_joined',
                'WAITING_TEXT_WELCOME': 'msg_welcome',
                'WAITING_TEXT_RULES': 'msg_rules'
            };

            if (textFieldsMap[state.mode]) {
                const databaseField = textFieldsMap[state.mode];
                await supabase.from('bot_settings').update({ [databaseField]: input }).eq('id', 1);
                await logAdminAction(userId, nickname, `Memodifikasi komponen teks template [${databaseField}]`);
                delete adminStates[userId];
                return ctx.reply("✅ Teks pesan kustom terbaru berhasil disimpan ke database!");
            }

        } catch (err) { console.error(err); return ctx.reply("❌ Terjadi kegagalan pemrosesan data."); }
    }

    if (ctx.message.text && ctx.message.text.startsWith('/')) return;

    // LOGIKA PENGIRIMAN MENFESS USER BIASA
    try {
        const { data: settings } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
        const { data: userDb } = await supabase.from('users').select('*').eq('telegram_id', userId).single();

        if (!settings) return ctx.reply("❌ Gagal memproses data, silakan ketik /start terlebih dahulu.");

        const isOwnerOrAdmin = (userId === OWNER_ID || userDb?.is_admin);

        if (!settings.is_active && !isOwnerOrAdmin) {
            return ctx.reply("⚠️ Menfess sedang dimatikan, harap hubungi @arikamukunaon");
        }

        if (userDb && userDb.is_banned) return ctx.reply("❌ Kamu telah di-ban seumur hidup dari bot ini karena melanggar aturan!");

        if (settings.channel_id === '-100xxxxx') return ctx.reply("⚠️ Channel tujuan menfess belum di-set di database.");

        if (!isOwnerOrAdmin) {
            const check = await checkMembership(ctx, userId, settings.channel_id, settings.group_id);
            if (!check.all) {
                const msgTeks = !check.channel && !check.group ? settings.msg_not_joined : settings.msg_half_joined;
                return ctx.reply(`⚠️ Akses Ditolak!\n\n${msgTeks}`, generateJoinKeyboard(settings, check));
            }
        }

        const isMedia = ctx.message.photo || ctx.message.video || ctx.message.animation;

        const currentUserTextQuota = userDb ? userDb.text_quota : (settings.default_text_quota ?? 15);
        const currentUserMediaQuota = userDb ? userDb.media_quota : (settings.default_media_quota ?? 5);

        if (!isOwnerOrAdmin) {
            if (isMedia && currentUserMediaQuota <= 0) return ctx.reply("❌ Kuota kirim MEDIA kamu hari ini sudah habis! Hubungi @arikamukunaon.");
            if (!isMedia && currentUserTextQuota <= 0) return ctx.reply("❌ Kuota kirim TEKS kamu hari ini sudah habis! Hubungi @arikamukunaon.");
        }

        const footerTeks = ``;
        let sentMessage;

        if (isMedia) {
            const userCaption = ctx.message.caption || '';
            const finalCaption = userCaption + footerTeks;

            if (ctx.message.photo) {
                const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                sentMessage = await ctx.telegram.sendPhoto(settings.channel_id, fileId, { caption: finalCaption, parse_mode: 'Markdown' });
            } else if (ctx.message.video) {
                sentMessage = await ctx.telegram.sendVideo(settings.channel_id, ctx.message.video.file_id, { caption: finalCaption, parse_mode: 'Markdown' });
            } else if (ctx.message.animation) {
                sentMessage = await ctx.telegram.sendAnimation(settings.channel_id, ctx.message.animation.file_id, { caption: finalCaption, parse_mode: 'Markdown' });
            }
        } else {
            const finalTeks = ctx.message.text + footerTeks;
            sentMessage = await ctx.telegram.sendMessage(settings.channel_id, finalTeks, { parse_mode: 'Markdown' });
        }

        if (sentMessage) {
            const laporanTeks = `🔔 *[ LAPORAN MENFESS MASUK ]*\n\n` +
                `👤 *Pengirim :* ${nickname} (${username})\n` +
                `🆔 *ID Telegram :* \`${userId}\`\n` +
                `📦 *Tipe :* ${isMedia ? 'Media' : 'Teks'}\n` +
                `📝 *Isi/Caption :* \n_${ctx.message.text || ctx.message.caption || '[Tanpa Teks]'}_`;
            try { await ctx.telegram.sendMessage(OWNER_ID, laporanTeks, { parse_mode: 'Markdown' }); } catch (e) { }

            if (!isOwnerOrAdmin && userDb) {
                if (isMedia) { await supabase.from('users').update({ media_quota: currentUserMediaQuota - 1 }).eq('telegram_id', userId); }
                else { await supabase.from('users').update({ text_quota: currentUserTextQuota - 1 }).eq('telegram_id', userId); }
            }

            const { data: updatedUser } = await supabase.from('users').select('text_quota, media_quota').eq('telegram_id', userId).single();

            // VALIDASI HAK AKSES HAPUS (Owner, Admin, atau User Khusus tepercaya)
            const canDelete = isOwnerOrAdmin || (userDb && userDb.can_delete_post);
            const replyButtons = [];
            replyButtons.push([Markup.button.callback('🗑️ Hapus Postingan Ini', `del_post_${sentMessage.message_id}`)]);

            return ctx.replyWithMarkdown(
                `✅ *Pesan Menfess lu berhasil dikirim secara anonim!*\n\n📊 *Sisa Kuota Hari Ini:*\n📝 Teks : ${isOwnerOrAdmin ? 'Infinity' : updatedUser.text_quota}\n🖼️ Media : ${isOwnerOrAdmin ? 'Infinity' : updatedUser.media_quota}`,
                Markup.inlineKeyboard(replyButtons)
            );
        }

    } catch (error) { console.error(error); ctx.reply("❌ Gagal memproses pesan menfess kamu."); }
});

// HAPUS BLOK BOT.LAUNCH() LAMA KAMU, GANTI DENGAN KODE INI:

export default async (req, res) => {
    try {
        if (req.method === 'POST') {
            // Ini untuk memproses pesan yang masuk dari Telegram ke Vercel
            await bot.handleUpdate(req.body);
            if (!res.writableEnded) {
                res.status(200).json({ ok: true });
            }
        } else {
            // Ini tampilan kalau link https://botmenfess.vercel.app dibuka di browser
            res.status(200).send('🟢 Bot Menfess is Running via Webhook!');
        }
    } catch (err) {
        console.error("Webhook Error:", err.message);
        if (!res.writableEnded) {
            res.status(500).send('Internal Server Error');
        }
    }
};