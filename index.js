require('dotenv').config();
const { Client, GatewayIntentBits, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes, ChannelType, AuditLogEvent } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Конфигурация
const config = {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.CLIENT_ID,
    guildId: process.env.GUILD_ID
};

// Создание клиента
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Настройки по умолчанию
let settings = {
    mentionProtection: {
        enabled: true,
        maxMentions: 5,
        timeWindow: 10000 // 10 секунд
    },
    channelProtection: {
        enabled: true,
        maxChannelsPerMinute: 3
    },
    roleProtection: {
        enabled: true,
        maxRolesPerMinute: 3
    },
    categoryProtection: {
        enabled: true,
        maxCategoriesPerMinute: 2
    },
    punishment: {
        users: {
            ban: false,
            mute: true,
            muteDuration: 7, // дней
            removeRoles: true
        },
        bots: {
            ban: true,
            removeRoles: true
        }
    },
    whitelist: []
};

// Хранение данных о действиях пользователей
const userActions = new Map();

// Ультрабыстрый трекер активности
const fastTracker = new Map();
const INSTANT_BAN_THRESHOLD = 2; // 2 действия за 500мс = бан
const ULTRA_FAST_WINDOW = 500; // 500 миллисекунд

// Трекер удалений для строгого контроля
const deletionTracker = new Map();
const DELETION_BAN_THRESHOLD = 2; // 2 удаления = бан/наказание
const DELETION_WINDOW = 1000; // 1 секунда (строже чем было)

// Трекер кулдаунов для создания/удаления
const cooldownTracker = new Map();
const COOLDOWN_TIME = 24 * 60 * 60 * 1000; // 1 день в миллисекундах

// Трекер удалений для участников (людей) - 2 удаления в день
const dailyDeletionTracker = new Map();
const DAILY_DELETION_LIMIT = 2; // 2 удаления в день для людей
const DAILY_WINDOW = 24 * 60 * 60 * 1000; // 24 часа в миллисекундах

// Мгновенная проверка активности (для ботов - 500мс, для людей - 1 сек)
function instantCheck(userId, isBot = false) {
    const now = Date.now();
    const window = isBot ? ULTRA_FAST_WINDOW : 1000; // 500мс для ботов, 1 сек для людей
    
    if (!fastTracker.has(userId)) {
        fastTracker.set(userId, []);
    }
    
    const activity = fastTracker.get(userId);
    
    // Очищаем старые записи
    const recent = activity.filter(time => now - time < window);
    recent.push(now);
    fastTracker.set(userId, recent);
    
    // Мгновенная блокировка при превышении лимита
    if (recent.length >= INSTANT_BAN_THRESHOLD) {
        console.log(`⚡ МГНОВЕННЫЙ БАН! ${recent.length} действий за ${window}мс от ${userId}`);
        return true;
    }
    
    return false;
}

// Отслеживание удалений для строгого контроля (теперь за 1 секунду)
function trackDeletion(userId, deletionType) {
    if (isWhitelisted(userId)) return false;
    
    const now = Date.now();
    
    if (!deletionTracker.has(userId)) {
        deletionTracker.set(userId, []);
    }
    
    const deletions = deletionTracker.get(userId);
    
    // Очищаем старые записи (старше 1 секунды)
    const recentDeletions = deletions.filter(deletion => now - deletion.time < DELETION_WINDOW);
    recentDeletions.push({ time: now, type: deletionType });
    deletionTracker.set(userId, recentDeletions);
    
    // Проверяем превышение лимита удалений
    if (recentDeletions.length >= DELETION_BAN_THRESHOLD) {
        const deletionTypes = recentDeletions.map(d => d.type).join(', ');
        console.log(`🚨 ЛИМИТ УДАЛЕНИЙ ПРЕВЫШЕН! ${recentDeletions.length} удалений за секунду от ${userId}: ${deletionTypes}`);
        return true;
    }
    
    return false;
}

// Проверка кулдауна для создания/удаления каналов, ролей, категорий
function checkCooldown(userId, actionType) {
    if (isWhitelisted(userId)) return false; // Белый список не ограничен кулдауном
    
    const now = Date.now();
    const userKey = `${userId}_${actionType}`;
    
    if (!cooldownTracker.has(userKey)) {
        cooldownTracker.set(userKey, now);
        return false; // Первое действие разрешено
    }
    
    const lastAction = cooldownTracker.get(userKey);
    const timeSinceLastAction = now - lastAction;
    
    if (timeSinceLastAction < COOLDOWN_TIME) {
        const remainingTime = Math.ceil((COOLDOWN_TIME - timeSinceLastAction) / (60 * 60 * 1000)); // в часах
        console.log(`⏰ КУЛДАУН! ${userId} попытался ${actionType}, осталось ${remainingTime} час(ов)`);
        return true; // Действие запрещено из-за кулдауна
    }
    
    cooldownTracker.set(userKey, now);
    return false; // Действие разрешено
}

// Проверка дневного лимита удалений для участников (людей)
function checkDailyDeletionLimit(userId) {
    if (isWhitelisted(userId)) return false; // Белый список не ограничен
    
    const now = Date.now();
    
    if (!dailyDeletionTracker.has(userId)) {
        dailyDeletionTracker.set(userId, []);
    }
    
    const deletions = dailyDeletionTracker.get(userId);
    
    // Очищаем старые записи (старше 24 часов)
    const recentDeletions = deletions.filter(deletion => now - deletion < DAILY_WINDOW);
    
    if (recentDeletions.length >= DAILY_DELETION_LIMIT) {
        console.log(`🚨 ДНЕВНОЙ ЛИМИТ ПРЕВЫШЕН! ${userId} удалил ${recentDeletions.length} объектов за день`);
        return true; // Лимит превышен
    }
    
    // Добавляем текущее удаление
    recentDeletions.push(now);
    dailyDeletionTracker.set(userId, recentDeletions);
    
    return false; // Лимит не превышен
}

// Проверка дневного лимита ссылок на ботов (2 в день)
function checkDailyBotLinkLimit(userId) {
    const now = Date.now();
    
    if (!dailyBotLinkTracker.has(userId)) {
        dailyBotLinkTracker.set(userId, []);
    }
    
    const links = dailyBotLinkTracker.get(userId);
    
    // Очищаем старые записи (старше 24 часов)
    const recentLinks = links.filter(link => now - link < DAILY_WINDOW);
    
    if (recentLinks.length >= DAILY_BOT_LINK_LIMIT) {
        console.log(`🚨 ДНЕВНОЙ ЛИМИТ ССЫЛОК ПРЕВЫШЕН! ${userId} отправил ${recentLinks.length} ссылок за день`);
        return true; // Лимит превышен
    }
    
    // Добавляем текущую ссылку
    recentLinks.push(now);
    dailyBotLinkTracker.set(userId, recentLinks);
    
    return false; // Лимит не превышен
}

// Функция загрузки настроек
function loadSettings() {
    try {
        if (fs.existsSync('settings.json')) {
            settings = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
        }
    } catch (error) {
        console.log('Ошибка загрузки настроек:', error);
    }
}

// Функция сохранения настроек
function saveSettings() {
    try {
        fs.writeFileSync('settings.json', JSON.stringify(settings, null, 2));
    } catch (error) {
        console.log('Ошибка сохранения настроек:', error);
    }
}

// Функция проверки белого списка
function isWhitelisted(userId) {
    return settings.whitelist.includes(userId);
}

// Функция проверки опасных прав у участника
function hasPrivilegedRoles(member) {
    const dangerousPermissions = [
        PermissionFlagsBits.Administrator,
        PermissionFlagsBits.ManageGuild,
        PermissionFlagsBits.ManageRoles,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.BanMembers,
        PermissionFlagsBits.KickMembers,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.MentionEveryone,
        PermissionFlagsBits.ManageWebhooks
    ];

    const privilegedRoles = member.roles.cache.filter(role => {
        return dangerousPermissions.some(permission => role.permissions.has(permission));
    });

    return privilegedRoles;
}

// Функция наказания
async function punishUser(guild, user, reason) {
    let member = guild.members.cache.get(user.id);
    
    // Если участник не в кеше, попробуем получить его с сервера
    if (!member) {
        try {
            member = await guild.members.fetch(user.id);
        } catch (error) {
            console.log(`Участник не найден: ${user.tag} (ID: ${user.id}) - возможно покинул сервер`);
            return;
        }
    }

    // Проверяем, не наш ли это бот
    if (member.id === client.user.id) {
        console.log(`Пропускаем самого себя ${member.user.tag}`);
        return;
    }

    // Проверяем, не владелец ли это сервера
    if (member.id === guild.ownerId) {
        console.log(`Нельзя наказать владельца сервера ${member.user.tag}`);
        return;
    }

    const botMember = guild.members.cache.get(client.user.id);
    if (!botMember) {
        console.log(`Бот не найден в гильдии`);
        return;
    }

    console.log(`🔍 Проверка прав для наказания ${member.user.tag}`);
    console.log(`Bot роль: ${botMember.roles.highest.name} (позиция: ${botMember.roles.highest.position})`);
    console.log(`Цель роль: ${member.roles.highest.name} (позиция: ${member.roles.highest.position})`);

    // Проверяем иерархию ролей - бот должен быть выше наказываемого
    if (member.roles.highest.position >= botMember.roles.highest.position) {
        console.log(`❌ Нельзя наказать ${member.user.tag} - его роль выше или равна роли бота`);
        return;
    }

    // ПРОВЕРКА СПРАВЕДЛИВОСТИ: Проверяем наличие привилегированных ролей
    const privilegedRoles = hasPrivilegedRoles(member);
    const hasPrivileges = privilegedRoles.size > 0;
    
    if (hasPrivileges) {
        console.log(`⚖️ СПРАВЕДЛИВОСТЬ: У ${member.user.tag} обнаружены роли с правами (${privilegedRoles.size} ролей)`);
        privilegedRoles.forEach(role => {
            console.log(`   - ${role.name} (права: ${role.permissions.toArray().join(', ')})`);
        });
    }

    try {
        let punishmentApplied = false;

        // Проверяем, является ли участник ботом
        if (member.user.bot) {
            // Для ботов - сначала убрать все роли, потом банить
            if (settings.punishment.bots.removeRoles && botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
                const rolesToRemove = member.roles.cache.filter(role =>
                    role.id !== guild.id && // Не @everyone роль
                    role.position < botMember.roles.highest.position // Роли ниже бота
                );

                let rolesRemoved = 0;
                for (const role of rolesToRemove.values()) {
                    try {
                        await member.roles.remove(role, reason);
                        console.log(`✅ Убрана роль ${role.name} у бота ${member.user.tag}`);
                        rolesRemoved++;
                    } catch (roleError) {
                        console.log(`❌ Не удалось убрать роль ${role.name} у бота: ${roleError.message}`);
                    }
                }

                if (rolesRemoved > 0) {
                    console.log(`✅ Убрано ${rolesRemoved} ролей у бота ${member.user.tag}`);
                    punishmentApplied = true;
                }
            }

            // Теперь банить бота
            if (settings.punishment.bots.ban && botMember.permissions.has(PermissionFlagsBits.BanMembers)) {
                try {
                    await member.ban({ reason: reason, deleteMessageDays: 7 });
                    console.log(`✅ Забанен бот ${member.user.tag}`);
                    punishmentApplied = true;
                } catch (banError) {
                    console.log(`❌ Не удалось забанить бота ${member.user.tag}: ${banError.message}`);
                }
            }
        } else {
            // ДЛЯ ЛЮДЕЙ: Особые правила справедливости
            
            // 1. ОБЯЗАТЕЛЬНОЕ снятие ВСЕХ ролей (особенно если есть привилегированные)
            if (botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
                const rolesToRemove = member.roles.cache.filter(role =>
                    role.id !== guild.id && // Не @everyone роль
                    role.position < botMember.roles.highest.position // Роли ниже бота
                );

                let rolesRemoved = 0;
                let privilegedRolesRemoved = 0;
                
                for (const role of rolesToRemove.values()) {
                    try {
                        const isPrivileged = privilegedRoles.has(role.id);
                        await member.roles.remove(role, `${reason} - ${isPrivileged ? 'ПРИВИЛЕГИРОВАННАЯ РОЛЬ' : 'обычная роль'}`);
                        console.log(`✅ Убрана роль ${role.name} у ${member.user.tag} ${isPrivileged ? '(ПРИВИЛЕГИРОВАННАЯ!)' : ''}`);
                        rolesRemoved++;
                        if (isPrivileged) privilegedRolesRemoved++;
                    } catch (roleError) {
                        console.log(`❌ Не удалось убрать роль ${role.name}: ${roleError.message}`);
                    }
                }

                if (rolesRemoved > 0) {
                    console.log(`✅ Убрано ${rolesRemoved} ролей у ${member.user.tag} (включая ${privilegedRolesRemoved} привилегированных)`);
                    punishmentApplied = true;
                }
            } else {
                console.log(`❌ Нет прав для управления ролями`);
            }

            // 2. ОБЯЗАТЕЛЬНЫЙ мут на 7 дней (особенно если были привилегии)
            if (botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
                try {
                    // Мут на 7 дней (обязательно для справедливости)
                    const muteTime = 7 * 24 * 60 * 60 * 1000; // 7 дней в миллисекундах
                    const fairnessReason = hasPrivileges ? 
                        `${reason} - СПРАВЕДЛИВОСТЬ: имел привилегированные роли` : 
                        `${reason} - мут на 7 дней`;
                        
                    await member.timeout(muteTime, fairnessReason);
                    console.log(`✅ Замучен ${member.user.tag} на 7 дней ${hasPrivileges ? '(СПРАВЕДЛИВОСТЬ за привилегии!)' : ''}`);
                    punishmentApplied = true;
                } catch (muteError) {
                    console.log(`❌ Не удалось замутить ${member.user.tag}: ${muteError.message}`);
                }
            } else {
                console.log(`❌ Нет прав для мута`);
            }

            // 3. Дополнительное логирование справедливости
            if (hasPrivileges) {
                console.log(`⚖️ СПРАВЕДЛИВОСТЬ ОБЕСПЕЧЕНА: ${member.user.tag} с привилегиями получил полное наказание`);
            }
        }

        if (!punishmentApplied) {
            console.log(`⚠️ Не удалось применить ни одно наказание к ${member.user.tag}`);
        } else {
            console.log(`✅ Наказание применено к ${member.user.tag} за: ${reason}`);
        }

    } catch (error) {
        console.log(`❌ Общая ошибка при наказании ${member.user.tag}:`, error.message);
    }
}

// Трекер предупреждений для приглашений ботов
const botInviteWarnings = new Map();

// Трекер предупреждений для белого списка при добавлении ботов
const whitelistBotWarnings = new Map();

// Трекер дневного лимита для ссылок приглашения ботов (2 в день)
const dailyBotLinkTracker = new Map();
const DAILY_BOT_LINK_LIMIT = 2; // 2 ссылки в день

// Трекер кулдаунов для добавления ботов (24 часа)
const botAddCooldown = new Map();
const BOT_ADD_COOLDOWN = 24 * 60 * 60 * 1000; // 1 день в миллисекундах

// Мониторинг сообщений и упоминаний
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (isWhitelisted(message.author.id)) return;

    // Проверка на ссылки приглашения ботов
    const botInviteRegex = /(?:discord\.com\/oauth2\/authorize|discordapp\.com\/oauth2\/authorize)/i;
    if (botInviteRegex.test(message.content)) {
        console.log(`🚨 ОБНАРУЖЕНА ССЫЛКА НА БОТА от ${message.author.tag}: ${message.content}`);
        
        // Удаляем сообщение
        await message.delete().catch(() => {});
        
        // СПЕЦИАЛЬНАЯ ПРОВЕРКА ДЛЯ БЕЛОГО СПИСКА
        if (isWhitelisted(message.author.id)) {
            console.log(`🚨 ПОЛЬЗОВАТЕЛЬ ИЗ БЕЛОГО СПИСКА отправил ссылку на бота: ${message.author.tag}`);
            
            // Проверяем количество предупреждений для белого списка
            const whitelistWarnings = whitelistBotWarnings.get(message.author.id) || 0;
            
            if (whitelistWarnings === 0) {
                // Первое предупреждение для пользователя белого списка
                whitelistBotWarnings.set(message.author.id, 1);
                
                try {
                    await message.author.send(`⚠️ **ПРЕДУПРЕЖДЕНИЕ (БЕЛЫЙ СПИСОК)**\n\nВы отправили ссылку для добавления бота на сервер "${message.guild.name}". Даже пользователи белого списка не могут добавлять ботов через ссылки!\n\n🔸 Это ваше первое предупреждение\n🔸 Только владелец сервера может добавлять ботов\n🔸 При повторной попытке вы будете исключены из белого списка и получите мут на 7 дней с кулдауном в 1 день\n\nПожалуйста, не повторяйте это действие.`);
                    console.log(`✅ Отправлено первое предупреждение пользователю белого списка ${message.author.tag}`);
                } catch (dmError) {
                    console.log(`❌ Не удалось отправить предупреждение ${message.author.tag}: ${dmError.message}`);
                }
            } else {
                // Повторное нарушение - исключение из белого списка
                console.log(`🚨 ИСКЛЮЧЕНИЕ ИЗ БЕЛОГО СПИСКА: ${message.author.tag} повторно отправил ссылку на бота`);
                
                // Исключаем из белого списка
                const index = settings.whitelist.indexOf(message.author.id);
                if (index !== -1) {
                    settings.whitelist.splice(index, 1);
                    saveSettings();
                    console.log(`✅ ${message.author.tag} исключен из белого списка за повторную отправку ссылки на бота`);
                }
                
                // Устанавливаем кулдаун на 1 день
                botAddCooldown.set(message.author.id, Date.now());
                
                try {
                    await message.author.send(`🚫 **ИСКЛЮЧЕНИЕ ИЗ БЕЛОГО СПИСКА**\n\nВы были исключены из белого списка сервера "${message.guild.name}" за повторную отправку ссылки на добавление бота после предупреждения!\n\n🔸 Вы больше не в привилегированном списке\n🔸 Получили мут на 7 дней и сняты все роли\n🔸 Кулдаун на добавление ботов: 1 день\n🔸 Только владелец сервера может добавлять ботов\n\nВаши привилегии отозваны.`);
                } catch (dmError) {
                    console.log(`❌ Не удалось отправить уведомление об исключении ${message.author.tag}: ${dmError.message}`);
                }
                
                // Наказываем как обычного пользователя
                await punishUser(message.guild, message.author, 'Повторная отправка ссылки на бота (исключен из белого списка)');
                whitelistBotWarnings.delete(message.author.id); // Сбрасываем счетчик
            }
            return;
        }
        
        // ПРОВЕРКА ДНЕВНОГО ЛИМИТА (2 ссылки в день)
        if (checkDailyBotLinkLimit(message.author.id)) {
            console.log(`🚨 ДНЕВНОЙ ЛИМИТ ССЫЛОК ПРЕВЫШЕН! Мут для ${message.author.tag}`);
            
            try {
                await message.author.send(`🚫 **МУТ ЗА ПРЕВЫШЕНИЕ ЛИМИТА**\n\nВы превысили дневной лимит отправки ссылок на ботов на сервере "${message.guild.name}"!\n\n🔸 Лимит: 2 ссылки в день\n🔸 Получили мут на 7 дней и сняты все роли\n🔸 Попробуйте завтра\n\nПожалуйста, соблюдайте правила сервера.`);
            } catch (dmError) {
                console.log(`❌ Не удалось отправить уведомление о превышении лимита ${message.author.tag}: ${dmError.message}`);
            }
            
            await punishUser(message.guild, message.author, 'Превышение дневного лимита ссылок на ботов (2 в день)');
            return;
        }
        
        // Проверяем количество предупреждений
        const warnings = botInviteWarnings.get(message.author.id) || 0;
        
        if (warnings === 0) {
            // Первое предупреждение
            botInviteWarnings.set(message.author.id, 1);
            
            try {
                await message.author.send(`⚠️ **ПРЕДУПРЕЖДЕНИЕ**\n\nВы отправили ссылку для добавления бота на сервер "${message.guild.name}". Это запрещено!\n\n🔸 Только владелец сервера может добавлять ботов\n🔸 Лимит: 2 ссылки в день\n🔸 При следующей попытке вы получите мут на 7 дней\n\nПожалуйста, не повторяйте это действие.`);
                console.log(`✅ Отправлено предупреждение ${message.author.tag} за ссылку на бота`);
            } catch (dmError) {
                console.log(`❌ Не удалось отправить предупреждение ${message.author.tag}: ${dmError.message}`);
            }
        } else {
            // Повторное нарушение - мут
            console.log(`🚨 ПОВТОРНАЯ ССЫЛКА НА БОТА! Мут для ${message.author.tag}`);
            
            try {
                await message.author.send(`🚫 **МУТ НА 7 ДНЕЙ**\n\nВы повторно отправили ссылку для добавления бота на сервер "${message.guild.name}" после предупреждения.\n\nВы получили мут на 7 дней. Все ваши роли также сняты.`);
            } catch (dmError) {
                console.log(`❌ Не удалось отправить уведомление о муте ${message.author.tag}: ${dmError.message}`);
            }
            
            await punishUser(message.guild, message.author, 'Повторная отправка ссылки на добавление бота');
            botInviteWarnings.delete(message.author.id); // Сбрасываем счетчик после наказания
        }
        return;
    }

    if (!settings.mentionProtection.enabled) return;

    // Мгновенная проверка спама
    if (instantCheck(message.author.id)) {
        console.log(`⚡ СПАМ СООБЩЕНИЙ! Мгновенный бан ${message.author.tag}`);
        await message.delete().catch(() => {});
        await punishUser(message.guild, message.author, 'Мгновенный спам сообщений');
        return;
    }

    const mentions = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 1 : 0);

    if (mentions >= settings.mentionProtection.maxMentions) {
        await message.delete().catch(() => {});
        await punishUser(message.guild, message.author, 'Спам упоминаний');
    }
});

// Мониторинг удаления сообщений
client.on('messageDelete', async (message) => {
    if (!message.guild || !message.author) return;
    
    const auditLogs = await message.guild.fetchAuditLogs({
        type: AuditLogEvent.MessageDelete,
        limit: 1
    });

    const entry = auditLogs.entries.first();
    if (!entry || isWhitelisted(entry.executor.id)) return;

    const isBot = entry.executor.bot;

    // Отслеживание удалений (теперь за 1 секунду)
    if (trackDeletion(entry.executor.id, 'сообщение')) {
        console.log(`🚨 БАН ЗА УДАЛЕНИЯ: ${entry.executor.tag} превысил лимит удалений за секунду`);
        await punishUser(message.guild, entry.executor, `ПРЕВЫШЕН ЛИМИТ: 2+ удалений за секунду`);
        return;
    }

    // Мгновенная проверка спама (разные временные окна для ботов и людей)
    if (instantCheck(entry.executor.id, isBot)) {
        const timeWindow = isBot ? '500мс' : '1 сек';
        console.log(`⚡ МГНОВЕННЫЙ БАН за удаление сообщений: ${entry.executor.tag} (${timeWindow})`);
        await punishUser(message.guild, entry.executor, `МГНОВЕННАЯ КРАШ-АТАКА: Удаление сообщений (${timeWindow})`);
    }
});

// Ультрабыстрое обнаружение краш-атак
async function ultraFastDetection(guild, executor) {
    if (isWhitelisted(executor.id)) return false;
    
    // Мгновенная проверка без аудит логов
    return instantCheck(executor.id);
}

// Мониторинг создания каналов с кулдауном и мгновенной реакцией
client.on('channelCreate', async (channel) => {
    if (!settings.channelProtection.enabled) return;

    const auditLogs = await channel.guild.fetchAuditLogs({
        type: AuditLogEvent.ChannelCreate,
        limit: 1
    });

    const entry = auditLogs.entries.first();
    if (!entry) return;

    const isBot = entry.executor.bot;

    // Если в белом списке - разрешаем
    if (isWhitelisted(entry.executor.id)) return;

    // Проверка кулдауна для пользователей (не ботов)
    if (!isBot && checkCooldown(entry.executor.id, 'создание_канала')) {
        console.log(`⏰ УДАЛЕНИЕ КАНАЛА из-за кулдауна: ${channel.name} от ${entry.executor.tag}`);
        await channel.delete().catch(() => {});
        await punishUser(channel.guild, entry.executor, 'Нарушение кулдауна: создание канала раньше чем через день');
        return;
    }

    // УЛЬТРАБЫСТРАЯ проверка (разные временные окна)
    if (instantCheck(entry.executor.id, isBot)) {
        const timeWindow = isBot ? '500мс' : '1 сек';
        console.log(`⚡ МГНОВЕННОЕ УДАЛЕНИЕ канала ${channel.name} от ${entry.executor.tag} (${timeWindow})`);
        await channel.delete().catch(() => {});
        await punishUser(channel.guild, entry.executor, `УЛЬТРАБЫСТРАЯ КРАШ-АТАКА - создание каналов (${timeWindow})`);
        return;
    }
});

client.on('roleCreate', async (role) => {
    if (!settings.roleProtection.enabled) return;

    // МГНОВЕННАЯ проверка админ прав БЕЗ ожидания аудит логов
    if (role.permissions.has(PermissionFlagsBits.Administrator)) {
        // Получаем аудит логи для проверки создателя
        const auditLogs = await role.guild.fetchAuditLogs({
            type: AuditLogEvent.RoleCreate,
            limit: 1
        });

        const entry = auditLogs.entries.first();
        if (entry && !isWhitelisted(entry.executor.id)) {
            console.log(`⚡ МГНОВЕННОЕ УДАЛЕНИЕ АДМИН РОЛИ от не-белого пользователя ${entry.executor.tag}: ${role.name}`);
            await role.delete().catch(() => {});
            await punishUser(role.guild, entry.executor, 'Создание роли с админ правами (не в белом списке)');
            return;
        }
    }

    const auditLogs = await role.guild.fetchAuditLogs({
        type: AuditLogEvent.RoleCreate,
        limit: 1
    });

    const entry = auditLogs.entries.first();
    if (!entry) return;

    const isBot = entry.executor.bot;

    // Если пользователь в белом списке - разрешаем
    if (isWhitelisted(entry.executor.id)) return;

    // Проверка кулдауна для пользователей (не ботов)
    if (!isBot && checkCooldown(entry.executor.id, 'создание_роли')) {
        console.log(`⏰ УДАЛЕНИЕ РОЛИ из-за кулдауна: ${role.name} от ${entry.executor.tag}`);
        await role.delete().catch(() => {});
        await punishUser(role.guild, entry.executor, 'Нарушение кулдауна: создание роли раньше чем через день');
        return;
    }

    // УЛЬТРАБЫСТРАЯ проверка для спама ролей (разные временные окна)
    if (instantCheck(entry.executor.id, isBot)) {
        const timeWindow = isBot ? '500мс' : '1 сек';
        console.log(`⚡ МГНОВЕННОЕ УДАЛЕНИЕ роли ${role.name} от ${entry.executor.tag} (${timeWindow})`);
        await role.delete().catch(() => {});
        await punishUser(role.guild, entry.executor, `УЛЬТРАБЫСТРАЯ КРАШ-АТАКА - создание ролей (${timeWindow})`);
        return;
    }
});

// Мониторинг обновления ролей (добавление админ прав)
client.on('roleUpdate', async (oldRole, newRole) => {
    if (!settings.roleProtection.enabled) return;

    // Проверяем, были ли добавлены админ права
    if (!oldRole.permissions.has(PermissionFlagsBits.Administrator) && 
        newRole.permissions.has(PermissionFlagsBits.Administrator)) {
        
        const auditLogs = await newRole.guild.fetchAuditLogs({
            type: AuditLogEvent.RoleUpdate,
            limit: 1
        });

        const entry = auditLogs.entries.first();
        if (!entry) return;

        // Если обновляющий НЕ в белом списке - отменяем админ права и наказываем
        if (!isWhitelisted(entry.executor.id)) {
            console.log(`🚨 БЛОКИРОВКА добавления админ прав к роли ${newRole.name} от ${entry.executor.tag}`);
            await newRole.setPermissions(oldRole.permissions, 'Блокировка добавления админ прав (не в белом списке)').catch(() => {});
            await punishUser(newRole.guild, entry.executor, 'Добавление админ прав к роли (не в белом списке)');
        }
    }
});

// Отдельный обработчик для категорий
client.on('channelCreate', async (channel) => {
    if (channel.type !== ChannelType.GuildCategory || !settings.categoryProtection.enabled) return;

    const auditLogs = await channel.guild.fetchAuditLogs({
        type: AuditLogEvent.ChannelCreate,
        limit: 1
    });

    const entry = auditLogs.entries.first();
    if (!entry) return;

    const isBot = entry.executor.bot;

    // Если в белом списке - разрешаем
    if (isWhitelisted(entry.executor.id)) return;

    // Проверка кулдауна для пользователей (не ботов)
    if (!isBot && checkCooldown(entry.executor.id, 'создание_категории')) {
        console.log(`⏰ УДАЛЕНИЕ КАТЕГОРИИ из-за кулдауна: ${channel.name} от ${entry.executor.tag}`);
        await channel.delete().catch(() => {});
        await punishUser(channel.guild, entry.executor, 'Нарушение кулдауна: создание категории раньше чем через день');
        return;
    }

    // УЛЬТРАБЫСТРАЯ проверка (разные временные окна)
    if (instantCheck(entry.executor.id, isBot)) {
        const timeWindow = isBot ? '500мс' : '1 сек';
        console.log(`⚡ МГНОВЕННОЕ УДАЛЕНИЕ категории ${channel.name} от ${entry.executor.tag} (${timeWindow})`);
        await channel.delete().catch(() => {});
        await punishUser(channel.guild, entry.executor, `УЛЬТРАБЫСТРАЯ КРАШ-АТАКА - создание категорий (${timeWindow})`);
        return;
    }
});

// Мониторинг удаления каналов с мгновенной реакцией
client.on('channelDelete', async (channel) => {
    const auditLogs = await channel.guild.fetchAuditLogs({
        type: AuditLogEvent.ChannelDelete,
        limit: 1
    });

    const entry = auditLogs.entries.first();
    if (!entry || isWhitelisted(entry.executor.id)) return;

    const isBot = entry.executor.bot;

    // Для людей (не ботов) - проверка дневного лимита удалений
    if (!isBot && checkDailyDeletionLimit(entry.executor.id)) {
        console.log(`🚨 ДНЕВНОЙ ЛИМИТ УДАЛЕНИЙ ПРЕВЫШЕН: ${entry.executor.tag} удалил канал ${channel.name}`);
        await punishUser(channel.guild, entry.executor, 'Превышен дневной лимит удалений (2 в день) - мут на 7 дней');
        return;
    }

    // Проверка кулдауна для пользователей (не ботов)
    if (!isBot && checkCooldown(entry.executor.id, 'удаление_канала')) {
        console.log(`⏰ НАКАЗАНИЕ за нарушение кулдауна удаления канала: ${entry.executor.tag}`);
        await punishUser(channel.guild, entry.executor, 'Нарушение кулдауна: удаление канала раньше чем через день');
        return;
    }

    // Отслеживание удалений (теперь за 1 секунду)
    if (trackDeletion(entry.executor.id, 'канал')) {
        console.log(`🚨 БАН ЗА УДАЛЕНИЯ: ${entry.executor.tag} превысил лимит удалений за секунду`);
        await punishUser(channel.guild, entry.executor, `ПРЕВЫШЕН ЛИМИТ: 2+ удалений за секунду`);
        return;
    }

    // УЛЬТРАБЫСТРАЯ проверка и наказание (разные временные окна)
    if (instantCheck(entry.executor.id, isBot)) {
        const timeWindow = isBot ? '500мс' : '1 сек';
        console.log(`⚡ МГНОВЕННЫЙ БАН за удаление каналов: ${entry.executor.tag} (${timeWindow})`);
        await punishUser(channel.guild, entry.executor, `УЛЬТРАБЫСТРАЯ КРАШ-АТАКА: Удаление каналов (${timeWindow})`);
    }
});

// Мониторинг удаления ролей с мгновенной реакцией  
client.on('roleDelete', async (role) => {
    const auditLogs = await role.guild.fetchAuditLogs({
        type: AuditLogEvent.RoleDelete,
        limit: 1
    });

    const entry = auditLogs.entries.first();
    if (!entry || isWhitelisted(entry.executor.id)) return;

    const isBot = entry.executor.bot;

    // Для людей (не ботов) - проверка дневного лимита удалений
    if (!isBot && checkDailyDeletionLimit(entry.executor.id)) {
        console.log(`🚨 ДНЕВНОЙ ЛИМИТ УДАЛЕНИЙ ПРЕВЫШЕН: ${entry.executor.tag} удалил роль ${role.name}`);
        await punishUser(role.guild, entry.executor, 'Превышен дневной лимит удалений (2 в день) - мут на 7 дней');
        return;
    }

    // Проверка кулдауна для пользователей (не ботов)
    if (!isBot && checkCooldown(entry.executor.id, 'удаление_роли')) {
        console.log(`⏰ НАКАЗАНИЕ за нарушение кулдауна удаления роли: ${entry.executor.tag}`);
        await punishUser(role.guild, entry.executor, 'Нарушение кулдауна: удаление роли раньше чем через день');
        return;
    }

    // Отслеживание удалений (теперь за 1 секунду)
    if (trackDeletion(entry.executor.id, 'роль')) {
        console.log(`🚨 БАН ЗА УДАЛЕНИЯ: ${entry.executor.tag} превысил лимит удалений за секунду`);
        await punishUser(role.guild, entry.executor, `ПРЕВЫШЕН ЛИМИТ: 2+ удалений за секунду`);
        return;
    }

    // УЛЬТРАБЫСТРАЯ проверка и наказание (разные временные окна)
    if (instantCheck(entry.executor.id, isBot)) {
        const timeWindow = isBot ? '500мс' : '1 сек';
        console.log(`⚡ МГНОВЕННЫЙ БАН за удаление ролей: ${entry.executor.tag} (${timeWindow})`);
        await punishUser(role.guild, entry.executor, `УЛЬТРАБЫСТРАЯ КРАШ-АТАКА: Удаление ролей (${timeWindow})`);
    }
});

// Мониторинг банов с контролем доступа
client.on('guildBanAdd', async (ban) => {
    const auditLogs = await ban.guild.fetchAuditLogs({
        type: AuditLogEvent.MemberBanAdd,
        limit: 1
    });

    const entry = auditLogs.entries.first();
    if (!entry) return;

    const isBot = entry.executor.bot;

    // Если банящий НЕ в белом списке - разбанить жертву и наказать банящего
    if (!isWhitelisted(entry.executor.id)) {
        console.log(`🚨 НЕСАНКЦИОНИРОВАННЫЙ БАН! ${entry.executor.tag} забанил ${ban.user.tag} без прав`);
        
        try {
            // Разбаниваем жертву
            await ban.guild.members.unban(ban.user.id, 'Несанкционированный бан - автоматический разбан');
            console.log(`✅ Разбанен ${ban.user.tag}`);
            
            // Создаем приглашение на сервер
            let inviteLink = null;
            try {
                const channels = ban.guild.channels.cache.filter(channel => 
                    channel.type === ChannelType.GuildText && 
                    channel.permissionsFor(ban.guild.members.me).has(PermissionFlagsBits.CreateInstantInvite)
                );
                
                if (channels.size > 0) {
                    const invite = await channels.first().createInvite({
                        maxAge: 0, // Бессрочное приглашение
                        maxUses: 1, // Одноразовое использование
                        reason: 'Автоматическое приглашение после несанкционированного бана'
                    });
                    inviteLink = invite.url;
                }
            } catch (inviteError) {
                console.log(`❌ Не удалось создать приглашение: ${inviteError.message}`);
            }
            
            // Отправляем ЛС разбаненному пользователю
            try {
                // Получаем полный объект пользователя
                const fullUser = await client.users.fetch(ban.user.id);
                
                const apologyMessage = `✅ **АВТОМАТИЧЕСКИЙ РАЗБАН**\n\nВы были некорректно забанены на сервере "${ban.guild.name}" пользователем, который не имел на это права.\n\n🔸 Бан автоматически отменен\n🔸 Нарушитель получил наказание`;
                const inviteMessage = inviteLink ? `\n\n🔗 Вы можете вернуться на сервер по этой ссылке: ${inviteLink}` : '';
                
                await fullUser.send(apologyMessage + inviteMessage);
                console.log(`✅ Отправлено извинение ${fullUser.tag}`);
            } catch (dmError) {
                console.log(`❌ Не удалось отправить ЛС ${ban.user.tag}: ${dmError.message}`);
                
                // Дополнительная диагностика
                if (dmError.code === 50007) {
                    console.log(`   Причина: У пользователя закрыты ЛС`);
                } else if (dmError.code === 50013) {
                    console.log(`   Причина: Недостаточно прав`);
                } else {
                    console.log(`   Код ошибки: ${dmError.code}`);
                }
            }
            
        } catch (unbanError) {
            console.log(`❌ Не удалось разбанить ${ban.user.tag}: ${unbanError.message}`);
        }
        
        // Наказываем того, кто дал несанкционированный бан
        await punishUser(ban.guild, entry.executor, 'Несанкционированный бан (не в белом списке) - мут на 7 дней');
        return;
    }

    // Если банящий В белом списке - стандартные проверки на краш-атаки
    // Отслеживание удалений (баны считаются как удаление участников)
    if (trackDeletion(entry.executor.id, 'участник (бан)')) {
        console.log(`🚨 БАН ЗА УДАЛЕНИЯ: ${entry.executor.tag} превысил лимит удалений за секунду`);
        await punishUser(ban.guild, entry.executor, `ПРЕВЫШЕН ЛИМИТ: 2+ удалений за секунду`);
        return;
    }

    // УЛЬТРАБЫСТРАЯ проверка (разные временные окна)
    if (instantCheck(entry.executor.id, isBot)) {
        const timeWindow = isBot ? '500мс' : '1 сек';
        console.log(`⚡ МГНОВЕННЫЙ БАН за массовые баны: ${entry.executor.tag} (${timeWindow})`);
        await punishUser(ban.guild, entry.executor, `УЛЬТРАБЫСТРАЯ КРАШ-АТАКА: Массовые баны (${timeWindow})`);
    }
});

// Мониторинг киков с мгновенной реакцией
client.on('guildMemberRemove', async (member) => {
    const auditLogs = await member.guild.fetchAuditLogs({
        type: AuditLogEvent.MemberKick,
        limit: 1
    });

    const entry = auditLogs.entries.first();
    if (!entry || entry.target.id !== member.id || isWhitelisted(entry.executor.id)) return;

    const isBot = entry.executor.bot;

    // Отслеживание удалений (кики считаются как удаление участников)
    if (trackDeletion(entry.executor.id, 'участник (кик)')) {
        console.log(`🚨 БАН ЗА УДАЛЕНИЯ: ${entry.executor.tag} превысил лимит удалений за секунду`);
        await punishUser(member.guild, entry.executor, `ПРЕВЫШЕН ЛИМИТ: 2+ удалений за секунду`);
        return;
    }

    // УЛЬТРАБЫСТРАЯ проверка (разные временные окна)
    if (instantCheck(entry.executor.id, isBot)) {
        const timeWindow = isBot ? '500мс' : '1 сек';
        console.log(`⚡ МГНОВЕННЫЙ БАН за массовые кики: ${entry.executor.tag} (${timeWindow})`);
        await punishUser(member.guild, entry.executor, `УЛЬТРАБЫСТРАЯ КРАШ-АТАКА: Массовые кики (${timeWindow})`);
    }
});

// Мониторинг добавления ботов
client.on('guildMemberAdd', async (member) => {
    if (!member.user.bot) return;

    const auditLogs = await member.guild.fetchAuditLogs({
        type: AuditLogEvent.BotAdd,
        limit: 1
    });

    const entry = auditLogs.entries.first();
    if (!entry) return;

    // СПЕЦИАЛЬНАЯ ПРОВЕРКА: Если добавляющий В белом списке - система предупреждений
    if (isWhitelisted(entry.executor.id)) {
        console.log(`🚨 ПОЛЬЗОВАТЕЛЬ ИЗ БЕЛОГО СПИСКА добавил бота: ${entry.executor.tag}`);
        
        // Проверяем кулдаун
        const lastBotAdd = botAddCooldown.get(entry.executor.id);
        if (lastBotAdd && Date.now() - lastBotAdd < BOT_ADD_COOLDOWN) {
            const remainingTime = Math.ceil((BOT_ADD_COOLDOWN - (Date.now() - lastBotAdd)) / (60 * 60 * 1000));
            console.log(`⏰ КУЛДАУН! ${entry.executor.tag} попытался добавить бота, осталось ${remainingTime} час(ов)`);
            
            // Банить бота и уведомлять о кулдауне
            await member.ban({ reason: 'Добавлен во время кулдауна' }).catch(() => {});
            
            try {
                await entry.executor.send(`⏰ **КУЛДАУН АКТИВЕН**\n\nВы не можете добавлять ботов на сервер "${member.guild.name}" из-за активного кулдауна!\n\n🔸 Бот "${member.user.tag}" был забанен\n🔸 Осталось времени: ${remainingTime} час(ов)\n🔸 Кулдаун установлен за предыдущее нарушение\n\nДождитесь окончания кулдауна.`);
            } catch (dmError) {
                console.log(`❌ Не удалось отправить уведомление о кулдауне ${entry.executor.tag}: ${dmError.message}`);
            }
            return;
        }
        
        // Проверяем количество предупреждений для белого списка
        const whitelistWarnings = whitelistBotWarnings.get(entry.executor.id) || 0;
        
        if (whitelistWarnings === 0) {
            // Первое предупреждение для пользователя белого списка
            whitelistBotWarnings.set(entry.executor.id, 1);
            
            // Банить бота
            await member.ban({ reason: 'Добавлен пользователем белого списка (первое предупреждение)' }).catch(() => {});
            
            try {
                await entry.executor.send(`⚠️ **ПРЕДУПРЕЖДЕНИЕ (БЕЛЫЙ СПИСОК)**\n\nВы добавили бота "${member.user.tag}" на сервер "${member.guild.name}". Даже пользователи белого списка не могут добавлять ботов!\n\n🔸 Это ваше первое предупреждение\n🔸 Бот был автоматически забанен\n🔸 Только владелец сервера может добавлять ботов\n🔸 При повторной попытке вы будете исключены из белого списка и получите мут на 7 дней с кулдауном в 1 день\n\nПожалуйста, не повторяйте это действие.`);
                console.log(`✅ Отправлено первое предупреждение пользователю белого списка ${entry.executor.tag}`);
            } catch (dmError) {
                console.log(`❌ Не удалось отправить предупреждение ${entry.executor.tag}: ${dmError.message}`);
            }
        } else {
            // Повторное нарушение - исключение из белого списка
            console.log(`🚨 ИСКЛЮЧЕНИЕ ИЗ БЕЛОГО СПИСКА: ${entry.executor.tag} повторно добавил бота`);
            
            // Исключаем из белого списка
            const index = settings.whitelist.indexOf(entry.executor.id);
            if (index !== -1) {
                settings.whitelist.splice(index, 1);
                saveSettings();
                console.log(`✅ ${entry.executor.tag} исключен из белого списка за повторное добавление бота`);
            }
            
            // Устанавливаем кулдаун на 1 день
            botAddCooldown.set(entry.executor.id, Date.now());
            
            try {
                await entry.executor.send(`🚫 **ИСКЛЮЧЕНИЕ ИЗ БЕЛОГО СПИСКА**\n\nВы были исключены из белого списка сервера "${member.guild.name}" за повторное добавление бота "${member.user.tag}" после предупреждения!\n\n🔸 Бот был автоматически забанен\n🔸 Вы больше не в привилегированном списке\n🔸 Получили мут на 7 дней и сняты все роли\n🔸 Кулдаун на добавление ботов: 1 день\n🔸 Только владелец сервера может добавлять ботов\n\nВаши привилегии отозваны.`);
                console.log(`✅ Отправлено уведомление об исключении ${entry.executor.tag}`);
            } catch (dmError) {
                console.log(`❌ Не удалось отправить уведомление об исключении ${entry.executor.tag}: ${dmError.message}`);
            }
            
            // Мгновенный бан нового бота
            await member.ban({ reason: 'Добавлен пользователем, исключенным из белого списка' }).catch(() => {});

            // Наказание того, кто добавил (теперь уже не в белом списке)
            await punishUser(member.guild, entry.executor, 'Повторное добавление бота (исключен из белого списка)');
            whitelistBotWarnings.delete(entry.executor.id); // Сбрасываем счетчик
        }
        return;
    }

    // Если добавляющий НЕ в белом списке - МГНОВЕННЫЙ БАН БОТА и наказание
    console.log(`🚨 БЛОКИРОВКА БОТА! ${member.user.tag} добавлен не-белым пользователем ${entry.executor.tag}`);
    
    // Отправляем предупреждение ПЕРЕД наказанием
    try {
        await entry.executor.send(`🚫 **ПРЕДУПРЕЖДЕНИЕ**\n\nВы попытались добавить бота "${member.user.tag}" на сервер "${member.guild.name}", но только владелец сервера может добавлять ботов!\n\n🔸 Бот был автоматически забанен\n🔸 Вы получили мут на 7 дней и сняты все роли\n🔸 При следующей попытке наказание будет строже\n\nПожалуйста, не повторяйте это действие.`);
        console.log(`✅ Отправлено уведомление ${entry.executor.tag} за добавление бота`);
    } catch (dmError) {
        console.log(`❌ Не удалось отправить уведомление ${entry.executor.tag}: ${dmError.message}`);
    }
    
    // Мгновенный бан нового бота
    await member.ban({ reason: 'Добавлен пользователем не из белого списка' }).catch(() => {});

    // Наказание того, кто добавил (даже если у него админ права)
    await punishUser(member.guild, entry.executor, 'Добавление бота (не в белом списке)');
});

// Команды
const commands = [
    new SlashCommandBuilder()
        .setName('настройки')
        .setDescription('Настройки антикраш системы')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('белыйсписок')
        .setDescription('Управление белым списком (только владелец сервера)')
        .addSubcommand(subcommand =>
            subcommand
                .setName('добавить')
                .setDescription('Добавить пользователя в белый список')
                .addUserOption(option =>
                    option.setName('пользователь')
                        .setDescription('Пользователь или бот для добавления')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('удалить')
                .setDescription('Удалить пользователя из белого списка')
                .addUserOption(option =>
                    option.setName('пользователь')
                        .setDescription('Пользователь или бот для удаления')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('список')
                .setDescription('Показать белый список'))
];

// Обработка команд
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'настройки') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'У вас нет прав для использования этой команды!', flags: 64 });
        }

        const embed = new EmbedBuilder()
            .setTitle('⚙️ Настройки Антикраш Системы')
            .setColor(0x00ff00)
            .addFields(
                { name: '🛡️ Защита от упоминаний', value: `${settings.mentionProtection.enabled ? '✅ Включена' : '❌ Выключена'}\nМакс. упоминаний: ${settings.mentionProtection.maxMentions}`, inline: true },
                { name: '📁 Защита каналов', value: `${settings.channelProtection.enabled ? '✅ Включена' : '❌ Выключена'}\nМакс. в минуту: ${settings.channelProtection.maxChannelsPerMinute}`, inline: true },
                { name: '👑 Защита ролей', value: `${settings.roleProtection.enabled ? '✅ Включена' : '❌ Выключена'}\nМакс. в минуту: ${settings.roleProtection.maxRolesPerMinute}`, inline: true },
                { name: '📂 Защита категорий', value: `${settings.categoryProtection.enabled ? '✅ Включена' : '❌ Выключена'}\nМакс. в минуту: ${settings.categoryProtection.maxCategoriesPerMinute}`, inline: true },
                { name: '⚖️ Наказания пользователей', value: `Бан: ${settings.punishment.users.ban ? '✅' : '❌'}\nМут: ${settings.punishment.users.mute ? '✅' : '❌'} (${settings.punishment.users.muteDuration} дней)\nУдаление ролей: ${settings.punishment.users.removeRoles ? '✅' : '❌'}`, inline: true },
                { name: '🤖 Наказания ботов', value: `Бан: ${settings.punishment.bots.ban ? '✅' : '❌'}\nУдаление ролей: ${settings.punishment.bots.removeRoles ? '✅' : '❌'}`, inline: true },
                { name: '📋 Белый список', value: `Пользователей: ${settings.whitelist.length}`, inline: true }
            );

        const buttons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('toggle_mention_protection')
                    .setLabel('Упоминания')
                    .setStyle(settings.mentionProtection.enabled ? ButtonStyle.Success : ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('toggle_channel_protection')
                    .setLabel('Каналы')
                    .setStyle(settings.channelProtection.enabled ? ButtonStyle.Success : ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('toggle_role_protection')
                    .setLabel('Роли')
                    .setStyle(settings.roleProtection.enabled ? ButtonStyle.Success : ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('toggle_category_protection')
                    .setLabel('Категории')
                    .setStyle(settings.categoryProtection.enabled ? ButtonStyle.Success : ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('user_punishment_settings')
                    .setLabel('Наказания пользователей')
                    .setStyle(ButtonStyle.Secondary)
            );

        const buttons2 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('bot_punishment_settings')
                    .setLabel('Наказания ботов')
                    .setStyle(ButtonStyle.Secondary)
            );

        await interaction.reply({ embeds: [embed], components: [buttons, buttons2], flags: 64 });
    }

    if (interaction.commandName === 'белыйсписок') {
        if (interaction.guild.ownerId !== interaction.user.id) {
            return interaction.reply({ content: 'Только владелец сервера может управлять белым списком!', ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'добавить') {
            const user = interaction.options.getUser('пользователь');

            if (settings.whitelist.includes(user.id)) {
                return interaction.reply({ content: `${user.bot ? 'Этот бот' : 'Этот пользователь'} уже в белом списке!`, flags: 64 });
            }

            settings.whitelist.push(user.id);
            saveSettings();

            await interaction.reply({ content: `✅ ${user.bot ? 'Бот' : 'Пользователь'} ${user.tag} добавлен в белый список!`, flags: 64 });
        }

        if (subcommand === 'удалить') {
            const user = interaction.options.getUser('пользователь');

            const index = settings.whitelist.indexOf(user.id);
            if (index === -1) {
                return interaction.reply({ content: `${user.bot ? 'Этого бота' : 'Этого пользователя'} нет в белом списке!`, flags: 64 });
            }

            settings.whitelist.splice(index, 1);
            saveSettings();

            await interaction.reply({ content: `✅ ${user.bot ? 'Бот' : 'Пользователь'} ${user.tag} удален из белого списка!`, flags: 64 });
        }

        if (subcommand === 'список') {
            let whitelistText = 'Белый список пуст';

            if (settings.whitelist.length > 0) {
                const users = [];
                for (const userId of settings.whitelist) {
                    try {
                        const user = await client.users.fetch(userId);
                        users.push(`${user.tag} (${userId})`);
                    } catch {
                        users.push(`Неизвестный пользователь (${userId})`);
                    }
                }
                whitelistText = users.join('\n');
            }

            const embed = new EmbedBuilder()
                .setTitle('📋 Белый список')
                .setDescription(whitelistText)
                .setColor(0x00ff00);

            await interaction.reply({ embeds: [embed], flags: 64 });
        }
    }
});

// Обработка кнопок
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'У вас нет прав для использования этой функции!', flags: 64 });
    }

    switch (interaction.customId) {
        case 'toggle_mention_protection':
            settings.mentionProtection.enabled = !settings.mentionProtection.enabled;
            saveSettings();
            await interaction.reply({ content: `Защита от упоминаний ${settings.mentionProtection.enabled ? 'включена' : 'выключена'}!`, flags: 64 });
            break;

        case 'toggle_channel_protection':
            settings.channelProtection.enabled = !settings.channelProtection.enabled;
            saveSettings();
            await interaction.reply({ content: `Защита каналов ${settings.channelProtection.enabled ? 'включена' : 'выключена'}!`, flags: 64 });
            break;

        case 'toggle_role_protection':
            settings.roleProtection.enabled = !settings.roleProtection.enabled;
            saveSettings();
            await interaction.reply({ content: `Защита ролей ${settings.roleProtection.enabled ? 'включена' : 'выключена'}!`, flags: 64 });
            break;

        case 'toggle_category_protection':
            settings.categoryProtection.enabled = !settings.categoryProtection.enabled;
            saveSettings();
            await interaction.reply({ content: `Защита категорий ${settings.categoryProtection.enabled ? 'включена' : 'выключена'}!`, flags: 64 });
            break;

        case 'user_punishment_settings':
            const userPunishmentEmbed = new EmbedBuilder()
                .setTitle('⚖️ Настройки наказаний для пользователей')
                .setColor(0xff9900)
                .addFields(
                    { name: '🔨 Бан', value: settings.punishment.users.ban ? '✅ Включен' : '❌ Выключен', inline: true },
                    { name: '🔇 Мут', value: settings.punishment.users.mute ? `✅ Включен (${settings.punishment.users.muteDuration} дней)` : '❌ Выключен', inline: true },
                    { name: '👤 Удаление ролей', value: settings.punishment.users.removeRoles ? '✅ Включено' : '❌ Выключено', inline: true }
                );

            const userPunishmentButtons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('toggle_user_ban')
                        .setLabel('Бан')
                        .setStyle(settings.punishment.users.ban ? ButtonStyle.Success : ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId('toggle_user_mute')
                        .setLabel('Мут')
                        .setStyle(settings.punishment.users.mute ? ButtonStyle.Success : ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId('toggle_user_remove_roles')
                        .setLabel('Удаление ролей')
                        .setStyle(settings.punishment.users.removeRoles ? ButtonStyle.Success : ButtonStyle.Danger)
                );

            await interaction.reply({ embeds: [userPunishmentEmbed], components: [userPunishmentButtons], flags: 64 });
            break;

        case 'bot_punishment_settings':
            const botPunishmentEmbed = new EmbedBuilder()
                .setTitle('🤖 Настройки наказаний для ботов')
                .setColor(0xff9900)
                .addFields(
                    { name: '🔨 Бан', value: settings.punishment.bots.ban ? '✅ Включен' : '❌ Выключен', inline: true },
                    { name: '👤 Удаление ролей', value: settings.punishment.bots.removeRoles ? '✅ Включено' : '❌ Выключено', inline: true }
                );

            const botPunishmentButtons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('toggle_bot_ban')
                        .setLabel('Бан')
                        .setStyle(settings.punishment.bots.ban ? ButtonStyle.Success : ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId('toggle_bot_remove_roles')
                        .setLabel('Удаление ролей')
                        .setStyle(settings.punishment.bots.removeRoles ? ButtonStyle.Success : ButtonStyle.Danger)
                );

            await interaction.reply({ embeds: [botPunishmentEmbed], components: [botPunishmentButtons], flags: 64 });
            break;

        case 'toggle_user_ban':
            settings.punishment.users.ban = !settings.punishment.users.ban;
            saveSettings();
            await interaction.reply({ content: `Наказание баном пользователей ${settings.punishment.users.ban ? 'включено' : 'выключено'}!`, flags: 64 });
            break;

        case 'toggle_user_mute':
            settings.punishment.users.mute = !settings.punishment.users.mute;
            saveSettings();
            await interaction.reply({ content: `Наказание мутом пользователей ${settings.punishment.users.mute ? 'включено' : 'выключено'}!`, flags: 64 });
            break;

        case 'toggle_user_remove_roles':
            settings.punishment.users.removeRoles = !settings.punishment.users.removeRoles;
            saveSettings();
            await interaction.reply({ content: `Удаление ролей у пользователей ${settings.punishment.users.removeRoles ? 'включено' : 'выключено'}!`, flags: 64 });
            break;

        case 'toggle_bot_ban':
            settings.punishment.bots.ban = !settings.punishment.bots.ban;
            saveSettings();
            await interaction.reply({ content: `Наказание баном ботов ${settings.punishment.bots.ban ? 'включено' : 'выключено'}!`, flags: 64 });
            break;

        case 'toggle_bot_remove_roles':
            settings.punishment.bots.removeRoles = !settings.punishment.bots.removeRoles;
            saveSettings();
            await interaction.reply({ content: `Удаление ролей у ботов ${settings.punishment.bots.removeRoles ? 'включено' : 'выключено'}!`, flags: 64 });
            break;
    }
});

// Регистрация команд
async function deployCommands() {
    try {
        const rest = new REST({ version: '10' }).setToken(config.token);

        console.log('Регистрация команд...');

        await rest.put(
            Routes.applicationGuildCommands(config.clientId, config.guildId),
            { body: commands }
        );

        console.log('Команды зарегистрированы!');
    } catch (error) {
        console.error(error);
    }
}

// Готовность бота
client.once('clientReady', async () => {
    console.log(`🤖 Бот ${client.user.tag} запущен и готов к работе!`);
    console.log(`🛡️ Антикраш система активна`);

    loadSettings();
    await deployCommands();
});

// Запуск бота
client.login(config.token);