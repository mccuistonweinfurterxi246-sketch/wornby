import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  Events,
} from 'discord.js';
import { folderStore } from './folderStore.js';
import { RobloxService } from './robloxService.js';

let client: Client | null = null;
let cronTimer: ReturnType<typeof setInterval> | null = null;
const WEBSITE_URL = (process.env.FRONTEND_URL || 'https://syntax3-app.vercel.app').replace(/\/$/, '');

// 60 секунд — быстрая реакция на снятие с продажи, возврат и новые дропы
const CHECK_INTERVAL_MS = (() => {
  const v = parseInt(process.env.CHECK_INTERVAL_MS || '', 10);
  if (Number.isFinite(v) && v >= 15_000) return v;
  return 60 * 1000; // 1 минута по умолчанию
})();

// ── Типы событий для идеального оповещения ──────────────────────────────────
type DropEvent = 'NEW' | 'BACK_ON_SALE' | 'OFF_SALE' | 'PRICE_CHANGE';

function eventMeta(event: DropEvent, price: number | null) {
  switch (event) {
    case 'NEW': return { color: 0x8B5CF6, emoji: '🆕', label: 'Новая вещь', footer: 'New drop' };
    case 'BACK_ON_SALE': return { color: 0x10B981, emoji: '✅', label: 'Снова в продаже', footer: 'Back on sale' };
    case 'OFF_SALE': return { color: 0xEF4444, emoji: '⛔', label: 'Снята с продажи', footer: 'Off sale' };
    case 'PRICE_CHANGE': return { color: 0xF59E0B, emoji: '💰', label: 'Цена изменилась', footer: price === 0 ? 'Now free' : `${price} R$` };
    default: return { color: 0x10B981, emoji: '🔔', label: 'Обновление', footer: 'Update' };
  }
}

function parseGroupId(input: string | number): number | null {
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) return input;
  const str = String(input).trim();
  const directNum = parseInt(str, 10);
  if (Number.isFinite(directNum) && directNum > 0 && /^\d+$/.test(str)) return directNum;
  // Парсинг ссылок: roblox.com/groups/32683521/... или roblox.com/communities/32683521/...
  const match = str.match(/(?:groups|communities)\/(\d+)/i);
  if (match && match[1]) {
    const id = parseInt(match[1], 10);
    if (Number.isFinite(id) && id > 0) return id;
  }
  return null;
}

async function notifySubscribers(
  discordUserIds: string[],
  groupId: number,
  groupInfo: any,
  item: { id: number; name: string; price?: number | null; isForSale?: boolean | null },
  event: DropEvent = 'NEW',
  extra?: { prevPrice?: number | null }
) {
  if (discordUserIds.length === 0) return;
  console.log(`[DiscordBot] dispatching [${event}] ${item.name} (#${item.id}) to ${discordUserIds.length} subscribers`);
  await Promise.allSettled(discordUserIds.map(uid => notifyDiscordUser(uid, groupId, groupInfo, item, event, extra)));
}

async function checkAllGroups(opts?: { itemsLimit?: number; maxGroups?: number }) {
  const allIds = await folderStore.getTrackedGroupIds();
  if (allIds.length === 0) return;
  
  const itemsLimit = opts?.itemsLimit ?? (process.env.VERCEL ? 20 : 25);
  const defaultMax = allIds.length > 15 ? 15 : allIds.length;
  const maxGroups = opts?.maxGroups ?? (process.env.VERCEL ? 3 : defaultMax);
  let groupIds = allIds;
  if (maxGroups < allIds.length) {
    const offset = Math.floor(Date.now() / CHECK_INTERVAL_MS) % allIds.length;
    groupIds = [...allIds.slice(offset), ...allIds.slice(0, offset)].slice(0, maxGroups);
  }

  // Получаем всех пользователей Discord для гарантии доставки даже если подписка не проставлена
  const globalStore = await folderStore.getStore().catch(()=> null);
  const allLinkedDiscords = Object.keys(globalStore?.links || {});

  for (let i = 0; i < groupIds.length; i += 3) {
    const batch = groupIds.slice(i, i + 3);
    await Promise.all(batch.map(async (gid) => {
      try {
        const allItems = await RobloxService.getAllGroupItems(gid, itemsLimit);
        if (allItems.length === 0) return;
        
        const previousStates = await folderStore.getItemStates(gid);
        const nextStates = { ...previousStates };
        const groupInfo = await RobloxService.getGroupInfo(gid).catch(()=> null);
        
        const explicitSubscribers = await folderStore.getSubscribers(gid);
        let subscribers = explicitSubscribers.length > 0 ? explicitSubscribers : allLinkedDiscords;
        if (subscribers.length === 0 && client?.user?.id) {
          subscribers = allLinkedDiscords;
        }
        
        const lastId = await folderStore.getLastItemId(gid);
        if (lastId == null) {
          // Первый запуск для группы — сидим тихо, только кэшируем без спама
          for (const item of allItems) {
            nextStates[String(item.id)] = {
              name: item.name,
              price: item.price,
              isForSale: item.isForSale
            };
          }
          await folderStore.setLastItemId(gid, allItems[0].id);
          await folderStore.setItemStates(gid, nextStates);
          try { (folderStore as any).flush?.(); } catch {}
          return;
        }

        const prevCount = Object.keys(previousStates).length;
        const isBackfill = prevCount > 0 && prevCount < allItems.length - 20;

        let newItems = 0, offSale = 0, backOnSale = 0, priceChanges = 0;

        for (let idx = 0; idx < allItems.length; idx++) {
          const item = allItems[idx];
          const prev = previousStates[String(item.id)];
          
          if (!prev) {
            // Новая вещь
            if (!isBackfill && idx < 25 && prevCount > 0) {
              if (subscribers.length > 0) {
                await notifySubscribers(subscribers, gid, groupInfo, item, 'NEW');
                newItems++;
              }
            }
          } else {
            if (prev.isForSale == null && item.isForSale != null) {
              // тихо хиллим
            } else if (prev.isForSale === false && item.isForSale === true) {
              // ВЕЩЬ СНОВА В ПРОДАЖЕ
              if (subscribers.length > 0) {
                await notifySubscribers(subscribers, gid, groupInfo, item, 'BACK_ON_SALE', { prevPrice: prev.price });
                backOnSale++;
              }
            } else if (prev.isForSale === true && item.isForSale === false) {
              // ВЕЩЬ СНЯТА С ПРОДАЖИ (OFF SALE)
              if (subscribers.length > 0) {
                await notifySubscribers(subscribers, gid, groupInfo, item, 'OFF_SALE', { prevPrice: prev.price });
                offSale++;
              }
            } else if (prev.isForSale === item.isForSale) {
              // Цена изменилась
              if (prev.price != null && item.price != null && prev.price !== item.price) {
                if (subscribers.length > 0) {
                  await notifySubscribers(subscribers, gid, groupInfo, item, 'PRICE_CHANGE', { prevPrice: prev.price });
                  priceChanges++;
                }
              }
            }
          }
          
          nextStates[String(item.id)] = {
            name: item.name,
            price: item.price !== undefined ? item.price : (prev?.price ?? null),
            isForSale: item.isForSale !== null && item.isForSale !== undefined ? item.isForSale : (prev?.isForSale ?? null)
          };
        }
        
        if (allItems[0]?.id && allItems[0].id !== lastId) await folderStore.setLastItemId(gid, allItems[0].id);
        await folderStore.setItemStates(gid, nextStates);
        try { (folderStore as any).flush?.(); } catch {}
        if (newItems || offSale || backOnSale || priceChanges) {
          console.log(`[DiscordBot] ${gid}: new=${newItems} off=${offSale} on=${backOnSale} price=${priceChanges}`);
        }
      } catch (e) {
        console.warn(`[DiscordBot] check ${gid} err`, (e as Error).message);
      }
    }));
    await new Promise(r=> setTimeout(r, 500));
  }
}

async function notifyDiscordUser(
  discordUserId: string,
  groupId: number,
  groupInfo: { name: string; memberCount: number; description?: string } | null,
  item: { id: number; name: string; price?: number | null; isForSale?: boolean | null },
  event: DropEvent = 'NEW',
  extra?: { prevPrice?: number | null }
) {
  try {
    const meta = eventMeta(event, item.price ?? null);
    const priceNow = item.price;
    const prevPrice = extra?.prevPrice;

    const safeGroupName = (groupInfo?.name ?? `Group #${groupId}`).toString().slice(0,80).replace(/[@`]/g,'·');
    const safeDesc = (groupInfo?.description ?? '').toString().slice(0,120).replace(/[@`]/g,'·').replace(/\n/g,' ');
    let title = '';
    let desc = '';
    switch (event) {
      case 'NEW':
        title = `${meta.emoji} ${item.name}`.replace(/[@`]/g,'·');
        desc = `**Новая вещь** в группе **${safeGroupName}**`;
        break;
      case 'BACK_ON_SALE': {
        const priceStr = priceNow != null ? `за **${priceNow} R$**` : 'снова доступна';
        const prevStr = prevPrice != null ? ` (было ${prevPrice} R$)` : '';
        title = `${meta.emoji} ${item.name} — снова в продаже`.replace(/[@`]/g,'·');
        desc = `Автор вернул вещь в продажу ${priceStr}${prevStr} • **${safeGroupName}**${safeDesc ? ` · *${safeDesc}*` : ''}`;
        break;
      }
      case 'OFF_SALE':
        title = `${meta.emoji} ${item.name} — снята с продажи`.replace(/[@`]/g,'·');
        desc = `Вещь **больше не продаётся** в группе **${safeGroupName}**${prevPrice != null ? ` (была ${prevPrice} R$)` : ''}`;
        break;
      case 'PRICE_CHANGE':
        title = `${meta.emoji} ${item.name} — цена изменилась`.replace(/[@`]/g,'·');
        desc = `Цена в группе **${safeGroupName}**: **${prevPrice ?? '—'} → ${priceNow ?? '—'} R$**`;
        break;
    }

    const priceField = (() => {
      if (event === 'OFF_SALE') return { name: 'Статус', value: '⛔ **Off Sale**', inline: true };
      if (priceNow == null) return { name: 'Цена', value: '—', inline: true };
      if (priceNow === 0) return { name: 'Цена', value: '🆓 **Free**', inline: true };
      return { name: 'Цена', value: `**${priceNow} R$**${prevPrice != null && event === 'PRICE_CHANGE' ? ` (было ${prevPrice} R$)` : ''}${event==='BACK_ON_SALE' && prevPrice != null && prevPrice !== priceNow ? ` (было ${prevPrice} R$)` : ''}`, inline: true };
    })();

    const statusField = (() => {
      if (event === 'BACK_ON_SALE') return { name: 'Статус', value: '✅ **For Sale**', inline: true };
      if (event === 'OFF_SALE') return { name: 'Статус', value: '⛔ **Not for sale**', inline: true };
      if (item.isForSale === true) return { name: 'Статус', value: '✅ For Sale', inline: true };
      if (item.isForSale === false) return { name: 'Статус', value: '⛔ Off Sale', inline: true };
      return { name: 'Статус', value: '—', inline: true };
    })();

    const embed = new EmbedBuilder()
      .setColor(meta.color)
      .setAuthor({ name: groupInfo?.name ?? `Group #${groupId}`, url: `https://www.roblox.com/groups/${groupId}` })
      .setTitle(title.slice(0, 256))
      .setURL(`https://www.roblox.com/catalog/${item.id}`)
      .setDescription(desc.slice(0, 4000))
      .addFields(
        priceField as any,
        statusField as any,
        { name: 'Group', value: `[#${groupId}](https://www.roblox.com/groups/${groupId})`, inline: true },
        { name: 'Members', value: groupInfo?.memberCount ? `**${groupInfo.memberCount.toLocaleString()}**` : '—', inline: true },
      )
      .setImage(`https://www.roblox.com/library/${item.id}/redirect?size=420`)
      .setFooter({ text: `WornBy Drops • ${meta.footer} • #${groupId} • ${meta.label}` })
      .setTimestamp(new Date());

    // 1) Gateway DM (локально / Railway)
    if (client) {
      try {
        const user = await client.users.fetch(discordUserId).catch(()=> null);
        if (user) {
          await user.send({ embeds: [embed] });
          console.log(`[DiscordBot] notified ${discordUserId} [${event}] ${item.name} (#${item.id}) in #${groupId} via Gateway`);
          return;
        }
      } catch {}
    }
    // 2) REST fallback
    const token = process.env.DISCORD_BOT_TOKEN?.trim();
    if (!token) return;
    try {
      const rest = new REST({ version: '10' }).setToken(token);
      const dmChannel = await rest.post(Routes.userChannels(), { body: { recipient_id: discordUserId } }) as { id: string };
      await rest.post(Routes.channelMessages(dmChannel.id), { body: { embeds: [embed.toJSON()] } });
      console.log(`[DiscordBot] notified ${discordUserId} [${event}] ${item.name} (#${item.id}) in #${groupId} via REST`);
    } catch (e) {
      console.warn(`[DiscordBot] notify REST ${discordUserId} err`, (e as Error).message);
    }
  } catch (e) {
    console.warn(`[DiscordBot] notify ${discordUserId} err`, (e as Error).message);
  }
}

async function registerCommands(token: string) {
  const rest = new REST({ version: '10' }).setToken(token);
  const commands = [
    new SlashCommandBuilder()
      .setName('track_player')
      .setDescription('Отслеживать ВСЕ группы игрока Roblox (в 1 клик)')
      .addStringOption(o=> o.setName('roblox_username').setDescription('Ник игрока Roblox (например galomf666)').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('track')
      .setDescription('Добавить группу по ID или ссылке')
      .addStringOption(o=> o.setName('group').setDescription('ID группы или ссылка на группу Roblox').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('folder')
      .setDescription('Показать все отслеживаемые группы')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('check')
      .setDescription('Мгновенно проверить все группы прямо сейчас')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('untrack')
      .setDescription('Убрать группу из отслеживания')
      .addStringOption(o=> o.setName('group').setDescription('ID группы или ссылка').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('clear')
      .setDescription('Очистить все свои отслеживаемые группы')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('link')
      .setDescription('Привязать Roblox ник и сразу загрузить все его группы')
      .addStringOption(o=> o.setName('roblox_username').setDescription('Ник Roblox (например galomf666)').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('unlink')
      .setDescription('Отвязать свой аккаунт')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Инструкция по использованию бота')
      .toJSON(),
  ];
  try {
    const appId = (await rest.get(Routes.oauth2CurrentApplication()) as { id: string }).id;
    // 1) Global
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    // 2) Guild-specific (мгновенное появление в Discord без ожидания глобального кэша)
    if (client) {
      for (const [guildId] of client.guilds.cache) {
        await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands }).catch(()=>{});
      }
    }
    console.log('[DiscordBot] slash commands registered globally and for all guilds');
  } catch (e) {
    console.warn('[DiscordBot] register commands err', (e as Error).message);
  }
}

// ── Вспомогательная функция отслеживания игрока ────────────────────────────
async function handleTrackPlayer(discordUserId: string, username: string): Promise<{ success: boolean; message?: string; embed?: EmbedBuilder }> {
  try {
    const user = await RobloxService.resolveUser(username);
    const groups = await RobloxService.getUserGroups(user.id);

    if (!groups || groups.length === 0) {
      return { success: false, message: `❌ У игрока **${user.name}** не найдено открытых групп в Roblox.` };
    }

    await folderStore.link(discordUserId, user.name);

    const metaToSave: { id: number; name: string; memberCount: number; iconUrl?: string }[] = [];
    for (const g of groups) {
      await folderStore.track(g.id, discordUserId, user.name);
      metaToSave.push({
        id: g.id,
        name: g.name,
        memberCount: g.memberCount,
        iconUrl: g.iconUrl ?? undefined,
      });
      RobloxService.getGroupNewItems(g.id, 1).then(async d => {
        const latest = d.items[0];
        if (latest?.id) await folderStore.setLastItemId(g.id, latest.id);
      }).catch(()=>{});
    }
    await folderStore.setGroupMetasBulk(metaToSave).catch(()=>{});

    setTimeout(() => checkAllGroups({ itemsLimit: 25, maxGroups: groups.length }), 2000);

    const embed = new EmbedBuilder()
      .setColor(0x10B981)
      .setTitle(`🎉 Подключено ${groups.length} групп игрока ${user.displayName || user.name}`)
      .setDescription(`Все **${groups.length} групп** игрока **[@${user.name}](https://www.roblox.com/users/${user.id}/profile)** добавлены в ваше отслеживание!\n\nБот опрашивает их каждую минуту. Уведомления о новых дропах и снятии с продажи будут приходить прямо сюда в DM.`)
      .addFields(
        groups.slice(0, 12).map(g => ({
          name: g.name.slice(0, 100),
          value: `👥 **${g.memberCount.toLocaleString()}** members · [\`#${g.id}\`](https://www.roblox.com/groups/${g.id})`,
          inline: true,
        }))
      )
      .setFooter({ text: groups.length > 12 ? `...и ещё ${groups.length - 12} групп. Напишите /folder или !folder для полного списка.` : 'WornBy Drops • Мониторинг активен' })
      .setTimestamp(new Date());

    return { success: true, embed };
  } catch (err) {
    return { success: false, message: `❌ Не удалось найти игрока **${username}** в Roblox. Проверьте правильность ника.` };
  }
}

export async function startDiscordBot(): Promise<Client | null> {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) {
    console.log('[DiscordBot] DISCORD_BOT_TOKEN not set — bot disabled');
    return null;
  }
  if (client) return client;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User],
  });

  client.on(Events.ClientReady, async () => {
    console.log(`[DiscordBot] ready as ${client!.user?.tag} (${client!.user?.id}) interval=${CHECK_INTERVAL_MS}ms`);
    await registerCommands(token);
    setTimeout(checkAllGroups, 3_000);
    if (cronTimer) clearInterval(cronTimer);
    cronTimer = setInterval(checkAllGroups, CHECK_INTERVAL_MS);
  });

  // ── Текстовые команды (!track_player galomf666, !folder, !check и т.д.) ──
  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot) return;
    const text = msg.content.trim();
    const discordUserId = msg.author.id;

    // !track_player / track_player / .track_player
    const trackPlayerMatch = text.match(/^[!/.]?track_player\s+([A-Za-z0-9_]+)$/i) || text.match(/^!trackplayer\s+([A-Za-z0-9_]+)$/i);
    if (trackPlayerMatch && trackPlayerMatch[1]) {
      const username = trackPlayerMatch[1];
      const replyMsg = await msg.reply(`⏳ Ищу группы игрока **${username}** в Roblox...`);
      const res = await handleTrackPlayer(discordUserId, username);
      if (res.embed) await replyMsg.edit({ content: '', embeds: [res.embed] });
      else await replyMsg.edit({ content: res.message || '❌ Ошибка' });
      return;
    }

    // !track / track
    const trackMatch = text.match(/^[!/.]?track\s+(\S+)$/i);
    if (trackMatch && trackMatch[1] && !text.toLowerCase().startsWith('!track_player')) {
      const gid = parseGroupId(trackMatch[1]);
      if (!gid) {
        await msg.reply('❌ Неверный ID или ссылка на группу. Пример: `!track 32683521` или `!track_player galomf666`');
        return;
      }
      const replyMsg = await msg.reply(`⏳ Получаю данные группы **#${gid}**...`);
      const info = await RobloxService.getGroupInfo(gid).catch(()=> null);
      await folderStore.track(gid, discordUserId);
      if (info?.name) {
        await folderStore.setGroupMeta(gid, { name: info.name, memberCount: info.memberCount ?? 0 }).catch(()=>{});
      }
      RobloxService.getGroupNewItems(gid, 1).then(async d => {
        const latest = d.items[0];
        if (latest?.id) await folderStore.setLastItemId(gid, latest.id);
      }).catch(()=>{});

      const embed = new EmbedBuilder()
        .setColor(0x10B981)
        .setTitle(`✅ Группа добавлена: ${info?.name ?? `Group #${gid}`}`)
        .setURL(`https://www.roblox.com/groups/${gid}`)
        .setDescription(`Группа **[${info?.name ?? `#${gid}`}](https://www.roblox.com/groups/${gid})** успешно добавлена в отслеживание!\n\nБот проверяет её каждую минуту и уведомит вас в DM.`)
        .addFields(
          { name: 'ID группы', value: `\`${gid}\``, inline: true },
          { name: 'Участников', value: info?.memberCount ? `**${info.memberCount.toLocaleString()}**` : '—', inline: true },
          { name: 'Интервал проверки', value: '⚡ Каждую минуту (60с)', inline: true },
        )
        .setTimestamp(new Date());

      await replyMsg.edit({ content: '', embeds: [embed] });
      return;
    }

    // !folder / folder
    if (/^[!/.]?folder$/i.test(text)) {
      const roblox = await folderStore.getRobloxForDiscord(discordUserId);
      const allGroups = await folderStore.getTrackedGroupIds();
      const savedMetas = await folderStore.getAllGroupMetas();
      const groupInfos: { id: number; name: string; memberCount: number }[] = [];

      for (const gid of allGroups) {
        const meta = savedMetas[String(gid)];
        groupInfos.push({
          id: gid,
          name: meta?.name || `Group #${gid}`,
          memberCount: meta?.memberCount ?? 0,
        });
      }

      if (groupInfos.length === 0) {
        await msg.reply('📁 Ваша папка пуста. Напишите `!track_player galomf666` чтобы добавить все группы игрока разом!');
        return;
      }

      groupInfos.sort((a,b)=> b.memberCount - a.memberCount);
      const embed = new EmbedBuilder()
        .setColor(0xF59E0B)
        .setAuthor({ name: `WornBy — ${roblox ? `@${roblox}` : 'Мои группы'}` })
        .setTitle(`📁 Отслеживается ${groupInfos.length} групп`)
        .setDescription(`Бот проверяет эти группы **каждую минуту** и присылает уведомления в DM.`)
        .addFields(groupInfos.slice(0, 25).map((g, idx) => ({
          name: `${idx + 1}. ${g.name}`.slice(0, 256),
          value: `👥 **${g.memberCount.toLocaleString()}** members · [\`#${g.id}\`](https://www.roblox.com/groups/${g.id})`,
          inline: true,
        })))
        .setFooter({ text: 'Добавить: !track_player <ник> или !track <ID> • Проверить: !check' })
        .setTimestamp(new Date());

      await msg.reply({ embeds: [embed] });
      return;
    }

    // !check / check
    if (/^[!/.]?check$/i.test(text)) {
      const allGroups = await folderStore.getTrackedGroupIds();
      const replyMsg = await msg.reply(`⚡ Запускаю проверку ${allGroups.length} групп...`);
      await checkAllGroups({ itemsLimit: 25, maxGroups: allGroups.length });
      await replyMsg.edit(`✅ Проверка завершена! Проверено **${allGroups.length} групп**. Все актуальные события отправлены в DM.`);
      return;
    }

    // !help / help
    if (/^[!/.]?help$/i.test(text)) {
      await msg.reply(
        '👑 **WornBy Drops — Команды в чате:**\n' +
        '• `!track_player galomf666` — отслеживать **все группы игрока** разом!\n' +
        '• `!track 32683521` — добавить группу по ID или ссылке\n' +
        '• `!folder` — открыть список своих групп\n' +
        '• `!check` — мгновенно проверить все группы прямо сейчас\n' +
        '• `!clear` — очистить список'
      );
      return;
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const discordUserId = interaction.user.id;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // ── /help ────────────────────────────────────────────────────────────
      if (interaction.commandName === 'help') {
        const embed = new EmbedBuilder()
          .setColor(0xF59E0B)
          .setTitle('👑 WornBy Drops — Инструкция по боту')
          .setDescription('Бот непрерывно отслеживает группы Roblox и мгновенно присылает уведомления в DM при выходе новых вещей, снятии с продажи и изменении цен.')
          .addFields(
            { name: '⚡ Быстрое добавление в 1 команду', value: 
              '`/track_player galomf666` — отслеживать **все группы игрока** разом!\n' +
              '`/track 32683521` — добавить группу по ID или ссылке\n' +
              '`/folder` — открыть список своих групп\n' +
              '`/check` — мгновенно проверить все группы прямо сейчас\n' +
              '`/untrack <ID>` — убрать группу из отслеживания\n' +
              '`/clear` — очистить список'
            },
            { name: '🔔 Что ловит бот (каждые 60 сек)', value:
              '• 🆕 **Новая вещь** в группе (с картинкой, ценой и ссылкой)\n' +
              '• ⛔ **Снята с продажи (Off Sale)**\n' +
              '• ✅ **Снова в продаже (Back on Sale)**\n' +
              '• 💰 **Изменение цены** (например 100 → 150 R$)'
            },
            { name: '🌐 Сайт', value: `[Открыть WornBy](${WEBSITE_URL})` }
          )
          .setFooter({ text: 'WornBy Drops • Мониторинг групп Roblox 24/7' });
        await interaction.editReply({ embeds: [embed] });

      // ── /track_player ────────────────────────────────────────────────────
      } else if (interaction.commandName === 'track_player') {
        const username = interaction.options.getString('roblox_username', true).trim();
        await interaction.editReply({ content: `⏳ Ищу группы игрока **${username}** в Roblox...` });

        try {
          const user = await RobloxService.resolveUser(username);
          const groups = await RobloxService.getUserGroups(user.id);

          if (!groups || groups.length === 0) {
            await interaction.editReply({ content: `❌ У игрока **${user.name}** не найдено открытых групп в Roblox.` });
            return;
          }

          // Привязываем ник к Discord
          await folderStore.link(discordUserId, user.name);

          const metaToSave: { id: number; name: string; memberCount: number; iconUrl?: string }[] = [];
          for (const g of groups) {
            await folderStore.track(g.id, discordUserId, user.name);
            metaToSave.push({
              id: g.id,
              name: g.name,
              memberCount: g.memberCount,
              iconUrl: g.iconUrl ?? undefined,
            });
            // Инициализация baseline
            RobloxService.getGroupNewItems(g.id, 1).then(async d => {
              const latest = d.items[0];
              if (latest?.id) await folderStore.setLastItemId(g.id, latest.id);
            }).catch(()=>{});
          }
          await folderStore.setGroupMetasBulk(metaToSave).catch(()=>{});

          // Прогреваем в фоне
          setTimeout(() => checkAllGroups({ itemsLimit: 25, maxGroups: groups.length }), 2000);

          const embed = new EmbedBuilder()
            .setColor(0x10B981)
            .setTitle(`🎉 Подключено ${groups.length} групп игрока ${user.displayName || user.name}`)
            .setDescription(`Все **${groups.length} групп** игрока **[@${user.name}](https://www.roblox.com/users/${user.id}/profile)** добавлены в ваше отслеживание!\n\nБот опрашивает их каждую минуту. Уведомления о новых дропах и снятии с продажи будут приходить прямо сюда в DM.`)
            .addFields(
              groups.slice(0, 10).map(g => ({
                name: g.name.slice(0, 100),
                value: `👥 **${g.memberCount.toLocaleString()}** members · [\`#${g.id}\`](https://www.roblox.com/groups/${g.id})`,
                inline: true,
              }))
            )
            .setFooter({ text: groups.length > 10 ? `...и ещё ${groups.length - 10} групп. Напишите /folder для полного списка.` : 'WornBy Drops • Мониторинг активен' })
            .setTimestamp(new Date());

          await interaction.editReply({ content: '', embeds: [embed] });
        } catch (err) {
          await interaction.editReply({ content: `❌ Не удалось найти игрока **${username}** в Roblox. Проверьте правильность ника.` });
        }

      // ── /track ───────────────────────────────────────────────────────────
      } else if (interaction.commandName === 'track') {
        const input = interaction.options.getString('group', true).trim();
        const gid = parseGroupId(input);

        if (!gid) {
          await interaction.editReply({ content: `❌ Неверный ID или ссылка на группу. Пример: \`/track 32683521\` или \`/track https://www.roblox.com/groups/32683521\`` });
          return;
        }

        await interaction.editReply({ content: `⏳ Получаю данные группы **#${gid}**...` });
        const info = await RobloxService.getGroupInfo(gid).catch(()=> null);

        await folderStore.track(gid, discordUserId);
        if (info?.name) {
          await folderStore.setGroupMeta(gid, {
            name: info.name,
            memberCount: info.memberCount ?? 0,
          }).catch(()=>{});
        }

        // Инициализируем baseline
        RobloxService.getGroupNewItems(gid, 1).then(async d => {
          const latest = d.items[0];
          if (latest?.id) await folderStore.setLastItemId(gid, latest.id);
        }).catch(()=>{});

        const embed = new EmbedBuilder()
          .setColor(0x10B981)
          .setTitle(`✅ Группа добавлена: ${info?.name ?? `Group #${gid}`}`)
          .setURL(`https://www.roblox.com/groups/${gid}`)
          .setDescription(`Группа **[${info?.name ?? `#${gid}`}](https://www.roblox.com/groups/${gid})** успешно добавлена в отслеживание!\n\nБот проверяет её каждую минуту и уведомит вас в DM при новых вещах, снятии с продажи или изменении цен.`)
          .addFields(
            { name: 'ID группы', value: `\`${gid}\``, inline: true },
            { name: 'Участников', value: info?.memberCount ? `**${info.memberCount.toLocaleString()}**` : '—', inline: true },
            { name: 'Интервал проверки', value: '⚡ Каждую минуту (60с)', inline: true },
          )
          .setFooter({ text: 'WornBy Drops • Напишите /folder чтобы посмотреть все группы' })
          .setTimestamp(new Date());

        await interaction.editReply({ content: '', embeds: [embed] });

      // ── /folder ──────────────────────────────────────────────────────────
      } else if (interaction.commandName === 'folder') {
        const roblox = await folderStore.getRobloxForDiscord(discordUserId);
        const allGroups = await folderStore.getTrackedGroupIds();
        const subsMap = new Map<number, string[]>();
        for (const gid of allGroups) subsMap.set(gid, await folderStore.getSubscribers(gid));
        
        let myGroups = allGroups.filter(gid => {
          const subs = subsMap.get(gid) ?? [];
          if (subs.includes(discordUserId)) return true;
          if (subs.length === 0) return true;
          return true;
        });
        
        // Авто-привязка подписки
        for (const gid of myGroups) {
          const subs = subsMap.get(gid) ?? [];
          if (!subs.includes(discordUserId)) {
            await folderStore.track(gid, discordUserId).catch(()=>{});
          }
        }
        
        if (myGroups.length === 0) {
          const emptyEmbed = new EmbedBuilder()
            .setColor(0xF59E0B)
            .setTitle('📁 Папка пуста')
            .setDescription(
              'У вас пока нет отслеживаемых групп.\n\n' +
              '**Как добавить группы:**\n' +
              '1. `/track_player <ник_roblox>` — например `/track_player galomf666` (добавит **все группы игрока** разом!)\n' +
              '2. `/track <ID или ссылка>` — например `/track 32683521`\n' +
              `3. Или [откройте сайт WornBy](${WEBSITE_URL}) и нажмите **Copy** у любой группы.`
            );
          await interaction.editReply({ embeds: [emptyEmbed] });
          return;
        }

        const savedMetas = await folderStore.getAllGroupMetas();
        const groupInfos: { id: number; name: string; memberCount: number }[] = [];
        const missingIds: number[] = [];

        for (const gid of myGroups) {
          const meta = savedMetas[String(gid)];
          if (meta?.name) {
            groupInfos.push({
              id: gid,
              name: meta.name,
              memberCount: meta.memberCount ?? 0,
            });
          } else {
            missingIds.push(gid);
          }
        }

        if (missingIds.length > 0) {
          for (let i = 0; i < missingIds.length; i += 5) {
            const batch = missingIds.slice(i, i + 5);
            await Promise.all(batch.map(async (gid) => {
              try {
                const info = await RobloxService.getGroupInfo(gid);
                if (info?.name) {
                  groupInfos.push({
                    id: gid,
                    name: info.name,
                    memberCount: info.memberCount ?? 0,
                  });
                  await folderStore.setGroupMeta(gid, {
                    name: info.name,
                    memberCount: info.memberCount ?? 0,
                  }).catch(() => {});
                } else {
                  groupInfos.push({ id: gid, name: `Group #${gid}`, memberCount: 0 });
                }
              } catch {
                groupInfos.push({ id: gid, name: `Group #${gid}`, memberCount: 0 });
              }
            }));
            if (i + 5 < missingIds.length) await new Promise(r => setTimeout(r, 300));
          }
        }

        groupInfos.sort((a,b)=> b.memberCount - a.memberCount);
        const chunks: typeof groupInfos[] = [];
        for (let i=0;i<groupInfos.length;i+=25) chunks.push(groupInfos.slice(i,i+25));
        
        const embeds = chunks.map((chunk, idx) => new EmbedBuilder()
          .setColor(0xF59E0B)
          .setAuthor({ name: `WornBy — ${roblox ? `@${roblox}` : 'Мои группы'}${chunks.length>1 ? ` (${idx+1}/${chunks.length})` : ''}` })
          .setTitle(idx===0 ? `📁 Отслеживается ${groupInfos.length} групп` : `📁 Продолжение списка (${idx+1}/${chunks.length})`)
          .setDescription(idx===0 ? `Бот проверяет эти группы **каждую минуту** и присылает уведомления в DM.` : `…ещё ${chunk.length} групп`)
          .addFields(chunk.map((g, itemIdx) => ({
            name: `${idx * 25 + itemIdx + 1}. ${g.name}`.slice(0,256),
            value: `👥 **${g.memberCount.toLocaleString()}** members · [\`#${g.id}\`](https://www.roblox.com/groups/${g.id})`,
            inline: true,
          })))
          .setFooter({ text: 'Добавить: /track_player или /track • Проверить: /check • Удалить: /untrack' })
          .setTimestamp(new Date()));

        await interaction.editReply({ embeds: embeds.slice(0, 10) });

      // ── /check ───────────────────────────────────────────────────────────
      } else if (interaction.commandName === 'check') {
        const allGroups = await folderStore.getTrackedGroupIds();
        await interaction.editReply({ content: `⚡ Запускаю мгновенную проверку ${allGroups.length} групп на новинки и изменения...` });
        await checkAllGroups({ itemsLimit: 25, maxGroups: allGroups.length });
        await interaction.editReply({ content: `✅ Проверка завершена! Проверено **${allGroups.length} групп**. Все актуальные события отправлены в DM.` });

      // ── /untrack ─────────────────────────────────────────────────────────
      } else if (interaction.commandName === 'untrack') {
        const input = interaction.options.getString('group', true).trim();
        const gid = parseGroupId(input);
        if (!gid) {
          await interaction.editReply({ content: `❌ Укажите корректный ID группы. Пример: \`/untrack 32683521\`` });
          return;
        }
        await folderStore.untrack(gid, discordUserId);
        await interaction.editReply({ content: `🗑️ Группа **#${gid}** убрана из отслеживания.` });

      // ── /clear ───────────────────────────────────────────────────────────
      } else if (interaction.commandName === 'clear') {
        const allGroups = await folderStore.getTrackedGroupIds();
        for (const gid of allGroups) {
          await folderStore.untrack(gid, discordUserId);
        }
        await interaction.editReply({ content: `🗑️ Все отслеживаемые группы успешно очищены.` });

      // ── /link ────────────────────────────────────────────────────────────
      } else if (interaction.commandName === 'link') {
        const roblox = interaction.options.getString('roblox_username', true).trim();
        if (!/^[A-Za-z0-9_]{2,25}$/.test(roblox)) {
          await interaction.editReply({ content: `❌ Неверный Roblox ник \`${roblox}\`` });
          return;
        }
        await interaction.editReply({ content: `⏳ Привязываю аккаунт и ищу все группы игрока **${roblox}**...` });
        const res = await handleTrackPlayer(discordUserId, roblox);
        if (res.embed) {
          await interaction.editReply({ content: `✅ Привязан аккаунт <@${discordUserId}> → **${roblox}**`, embeds: [res.embed] });
        } else {
          await folderStore.link(discordUserId, roblox);
          await interaction.editReply({ content: `✅ Привязан аккаунт <@${discordUserId}> → **${roblox}**` });
        }

      // ── /unlink ──────────────────────────────────────────────────────────
      } else if (interaction.commandName === 'unlink') {
        await folderStore.unlink(discordUserId);
        await interaction.editReply({ content: `🔓 Аккаунт отвязан.` });
      }
    } catch (e) {
      console.warn('[DiscordBot] interaction err', (e as Error).message);
      if (interaction.isRepliable()) {
        const errorReply = interaction.deferred || interaction.replied
          ? interaction.editReply({ content: `❌ Произошла ошибка при выполнении команды.` })
          : interaction.reply({ content: `❌ Произошла ошибка при выполнении команды.`, flags: MessageFlags.Ephemeral });
        await errorReply.catch(()=>{});
      }
    }
  });

  client.on(Events.Error, (e)=> console.warn('[DiscordBot] error', e));

  await client.login(token);
  return client;
}

export function getDiscordClient(): Client | null {
  return client;
}

export async function notifyNewItemForGroup(groupId: number, item: { id:number; name:string; price?:number|null; isForSale?: boolean | null }) {
  const subscribers = await folderStore.getSubscribers(groupId);
  if (subscribers.length === 0) return;
  const groupInfo = await RobloxService.getGroupInfo(groupId).catch(()=> null);
  for (const uid of subscribers) await notifyDiscordUser(uid, groupId, groupInfo, item, 'NEW');
}

export { checkAllGroups };
