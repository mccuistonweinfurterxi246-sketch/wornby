import { Client, GatewayIntentBits, Partials, EmbedBuilder, SlashCommandBuilder, REST, Routes, Events, MessageFlags } from 'discord.js';
import { folderStore } from './folderStore.js';
import { RobloxService } from './robloxService.js';

let client: Client | null = null;
let cronTimer: ReturnType<typeof setInterval> | null = null;
const WEBSITE_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

// 7 минут — баланс между актуальностью и 429 rate-limit от Roblox. Можно переопределить через env для тестов.
const CHECK_INTERVAL_MS = (() => {
  const v = parseInt(process.env.CHECK_INTERVAL_MS || '', 10);
  if (Number.isFinite(v) && v >= 30_000) return v;
  return 7 * 60 * 1000;
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

async function notifySubscribers(
  discordUserIds: string[],
  groupId: number,
  groupInfo: any,
  item: { id: number; name: string; price?: number | null; isForSale?: boolean | null },
  event: DropEvent = 'NEW',
  extra?: { prevPrice?: number | null }
) {
  if (discordUserIds.length === 0) return;
  await Promise.allSettled(discordUserIds.map(uid => notifyDiscordUser(uid, groupId, groupInfo, item, event, extra)));
}

async function checkAllGroups(opts?: { itemsLimit?: number; maxGroups?: number }) {
  const allIds = await folderStore.getTrackedGroupIds();
  if (allIds.length === 0) return;
  
  // 25 вещей на группу достаточно для отслеживания всех новинок, снятия и возврата в продажу без 429
  const itemsLimit = opts?.itemsLimit ?? (process.env.VERCEL ? 20 : 25);
  // Проверяем по 12 групп за тик (для 35 групп полный круг занимает ~3 тика)
  const defaultMax = allIds.length > 12 ? 12 : allIds.length;
  const maxGroups = opts?.maxGroups ?? (process.env.VERCEL ? 3 : defaultMax);
  let groupIds = allIds;
  if (maxGroups < allIds.length) {
    const offset = Math.floor(Date.now() / CHECK_INTERVAL_MS) % allIds.length;
    groupIds = [...allIds.slice(offset), ...allIds.slice(0, offset)].slice(0, maxGroups);
    console.log(`[DiscordBot] cron rotation offset=${offset} checking ${groupIds.length}/${allIds.length}`);
  }
  console.log(`[DiscordBot] tick: checking ${groupIds.length} groups (interval ${Math.round(CHECK_INTERVAL_MS/60000)}m) Redis=${!!process.env.REDIS_URL || !!process.env.STORAGE_URL ? 'on' : 'file'} limit=${itemsLimit}`);

  for (let i = 0; i < groupIds.length; i += 3) {
    const batch = groupIds.slice(i, i + 3);
    await Promise.all(batch.map(async (gid) => {
      try {
        const allItems = await RobloxService.getAllGroupItems(gid, itemsLimit);
        if (allItems.length === 0) {
          console.log(`[DiscordBot] ${gid}: no items returned (group empty or API 429)`);
          return;
        }
        
        const previousStates = await folderStore.getItemStates(gid);
        const nextStates = { ...previousStates };
        const groupInfo = await RobloxService.getGroupInfo(gid).catch(()=> null);
        const subscribers = await folderStore.getSubscribers(gid);
        
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
          // немедленный flush — чтобы при рестарте не потерять инициализацию и не заспамить заново
          try { (folderStore as any).flush?.(); } catch {}
          console.log(`[DiscordBot] ${gid}: initialized ${allItems.length} items, lastId=${allItems[0].id}`);
          return;
        }

        const prevCount = Object.keys(previousStates).length;
        // Защита от спама при бэкфилле: если раньше знали 5 вещей, а сейчас пришло 120 — не анонсируем старые как новые
        const isBackfill = prevCount > 0 && prevCount < allItems.length - 30;
        if (isBackfill) console.log(`[DiscordBot] ${gid}: backfill detected prev=${prevCount} now=${allItems.length} — suppress new-item spam`);

        let newItems = 0, offSale = 0, backOnSale = 0, priceChanges = 0;

        for (let idx = 0; idx < allItems.length; idx++) {
          const item = allItems[idx];
          const prev = previousStates[String(item.id)];
          
          if (!prev) {
            // Новая вещь — анонсируем только если в топ-30 (RecentlyCreated) и не бэкфилл
            if (!isBackfill && idx < 30 && prevCount > 0) {
              if (subscribers.length > 0) {
                await notifySubscribers(subscribers, gid, groupInfo, item, 'NEW');
                newItems++;
              }
            }
          } else {
            // Миграция битых null-состояний после фикса PascalCase бага (когда price null, isForSale null)
            // Первый тик после фикса тихо хиллит базу без спама.
            if (prev.isForSale == null && item.isForSale != null) {
              // тихо чиним, не уведомляем — это не реальный ивент, а починка кэша
            } else if (prev.isForSale === false && item.isForSale === true) {
              // Вещь вернулась в продажу — автор снова указал цену и включил продажу
              // Двойная проверка через свежий economy запрос чтобы не словить ложный триггер из-за 429/timeout
              try {
                const details = await RobloxService.getEconomyAssetDetails(item.id, undefined, true);
                const confirmed = (details as unknown as Record<string, unknown>)?.['isForSale'] === true
                  || (details as any)?.IsForSale === true;
                // если details не пришел (429) — доверяем item.isForSale но логируем
                if (confirmed || (details == null && item.isForSale === true)) {
                  if (details && typeof (details as any).price !== 'undefined') {
                    const fresh = (details as any).price as number | null;
                    if (fresh !== null) item.price = fresh;
                  }
                  if (subscribers.length > 0) {
                    await notifySubscribers(subscribers, gid, groupInfo, item, 'BACK_ON_SALE', { prevPrice: prev.price });
                    backOnSale++;
                  }
                } else if (details && (details as any).isForSale === false) {
                  // item соврал (кэш каталога), а экономика говорит всё ещё off-sale — фиксим
                  item.isForSale = false;
                }
              } catch {}
            } else if (prev.isForSale === true && item.isForSale === false) {
              // Вещь снята с продажи — критичное событие, которое ты просил
              try {
                const details = await RobloxService.getEconomyAssetDetails(item.id, undefined, true);
                const d = details as unknown as Record<string, unknown> | null;
                const confirmedOff = d != null && ((d['isForSale'] === false) || (d['isOffSale'] === true) || (d as any).IsForSale === false || (d as any).IsOffSale === true);
                // Только если экономика подтвердила off-sale — шлём, чтобы не спамить при 429
                if (confirmedOff) {
                  item.isForSale = false;
                  if (subscribers.length > 0) {
                    await notifySubscribers(subscribers, gid, groupInfo, item, 'OFF_SALE', { prevPrice: prev.price });
                    offSale++;
                  }
                } else if (d == null) {
                  // 429/timeout — не считаем снятием, ждём след тика
                  item.isForSale = prev.isForSale; // откатываем чтобы не потерять true
                }
              } catch {}
            } else if (prev.isForSale === item.isForSale) {
              // Цена изменилась при неизменном статусе продажи
              // Игнорируем heal с null (битый кэш) — не спамим на первом тике после фикса
              if (prev.price == null || item.price == null) {
                // тихо хиллим цену
              } else if (typeof prev.price === 'number' && typeof item.price === 'number' && prev.price !== item.price) {
                if (subscribers.length > 0) {
                  await notifySubscribers(subscribers, gid, groupInfo, item, 'PRICE_CHANGE', { prevPrice: prev.price });
                  priceChanges++;
                }
              } else if (prev.price !== item.price) {
                // на случай строки / free 0 vs null
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
    await new Promise(r=> setTimeout(r, 1200));
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

    // Заголовок и описание по типу события — идеально для кейса "сняли и вернули в продажу, указав цену"
    // CSP: sanitize group description/name to avoid @everyone/@here ping и markdown injection в Discord
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

    // 1) пробуем Gateway client (локально)
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
    // 2) REST fallback (Vercel serverless — нет Gateway)
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
    new SlashCommandBuilder().setName('help').setDescription('Как подключить сайт и получать уведомления').toJSON(),
    new SlashCommandBuilder().setName('link').setDescription('Резервная привязка Roblox к Discord').addStringOption(o=> o.setName('roblox_username').setDescription('Roblox username').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('unlink').setDescription('Отключить свои уведомления').toJSON(),
    new SlashCommandBuilder().setName('folder').setDescription('Показать свои группы').toJSON(),
    new SlashCommandBuilder().setName('track').setDescription('Добавить группу по ID').addIntegerOption(o=> o.setName('group_id').setDescription('ID группы').setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName('untrack').setDescription('Убрать группу из своих подписок').addIntegerOption(o=> o.setName('group_id').setDescription('ID группы').setRequired(true)).toJSON(),
  ];
  try {
    // global commands
    await rest.put(Routes.applicationCommands((await rest.get(Routes.oauth2CurrentApplication()) as { id: string }).id), { body: commands });
    console.log('[DiscordBot] slash commands registered');
  } catch (e) {
    console.warn('[DiscordBot] register commands err', (e as Error).message);
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
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel, Partials.Message, Partials.User],
  });

  client.on(Events.ClientReady, async () => {
    console.log(`[DiscordBot] ready as ${client!.user?.tag} (${client!.user?.id}) interval=${CHECK_INTERVAL_MS}ms`);
    await registerCommands(token);
    // первый чек через 30с, потом по интервалу
    setTimeout(checkAllGroups, 30_000);
    if (cronTimer) clearInterval(cronTimer);
    cronTimer = setInterval(checkAllGroups, CHECK_INTERVAL_MS);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const discordUserId = interaction.user.id;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (interaction.commandName === 'help') {
        const isRussian = interaction.locale?.toLowerCase().startsWith('ru');
        const embed = new EmbedBuilder()
          .setColor(0xF59E0B)
          .setTitle(isRussian ? 'WornBy Drops — инструкция' : 'WornBy Drops — Quick start')
          .setDescription(isRussian
            ? 'Бот следит за группами из твоей папки на сайте и присылает важные изменения в личные сообщения.'
            : 'The bot watches groups in your website folder and sends important changes to your DMs.')
          .addFields(
            { name: isRussian ? 'Как начать (1 клик)' : 'Get started (1 click)', value: isRussian
              ? `1. [Открой WornBy](${WEBSITE_URL}) → нажми **Connect Discord** (ник Roblox вводить не надо).\n2. Подтверди в Discord → вернёт на сайт.\n3. Нажми **Copy** у любой группы — бот уже следит и пришлёт DM.`
              : `1. [Open WornBy](${WEBSITE_URL}) → click **Connect Discord** (no Roblox name needed).\n2. Authorize → back to site.\n3. Click **Copy** on any group — bot will DM you.` },
            { name: isRussian ? 'Что отслеживается' : 'What is tracked', value: isRussian
              ? 'Новая одежда/аксессуар, **снятие с продажи**, **возврат в продажу (с указанием цены)** и изменение цены.'
              : 'New clothing/accessories, **going off sale**, **back on sale (with price)**, and price changes.' },
            { name: isRussian ? 'Нужно ли /link?' : 'Need /link?', value: isRussian
              ? 'Нет — `/link` это резерв если сайт не открывается. Для сайта достаточно `Connect Discord`.'
              : 'No — `/link` is fallback if site is down. For site just use `Connect Discord`.' },
            { name: isRussian ? 'Команды' : 'Commands', value: isRussian
              ? '`/folder` — мои группы\n`/untrack ID` — убрать группу\n`/unlink` — отключить уведомления'
              : '`/folder` — my groups\n`/untrack ID` — remove a group\n`/unlink` — disable notifications' },
            { name: isRussian ? 'Сайт' : 'Website', value: `[${WEBSITE_URL}](${WEBSITE_URL})` },
          )
          .setFooter({ text: isRussian ? 'Логин Roblox в Discord вводить не нужно.' : 'You never need to enter your Roblox login in Discord.' });
        await interaction.editReply({ embeds: [embed] });
      } else if (interaction.commandName === 'link') {
        const roblox = interaction.options.getString('roblox_username', true).trim();
        if (!/^[A-Za-z][A-Za-z0-9_]{2,19}$/.test(roblox)) {
          await interaction.editReply({ content: `❌ Invalid Roblox username \`${roblox}\`` });
          return;
        }
        await folderStore.link(discordUserId, roblox);
        await interaction.editReply({ content: `✅ Linked <@${discordUserId}> → **${roblox}**\nТеперь скопированные на сайте группы для **${roblox}** будут приходить тебе в DM.` });
      } else if (interaction.commandName === 'unlink') {
        await folderStore.unlink(discordUserId);
        await interaction.editReply({ content: `🔓 Unlinked.` });
      } else if (interaction.commandName === 'folder') {
        const roblox = await folderStore.getRobloxForDiscord(discordUserId);
        const allGroups = await folderStore.getTrackedGroupIds();
        const subsMap = new Map<number, string[]>();
        for (const gid of allGroups) subsMap.set(gid, await folderStore.getSubscribers(gid));
        
        // Включаем все группы, привязанные к пользователю или сохраненные на сайте
        let myGroups = allGroups.filter(gid => {
          const subs = subsMap.get(gid) ?? [];
          if (subs.includes(discordUserId)) return true;
          if (subs.length === 0) return true;
          return true;
        });
        
        // Авто-привязка подписки на случай, если группы скопированы без входа
        for (const gid of myGroups) {
          const subs = subsMap.get(gid) ?? [];
          if (!subs.includes(discordUserId)) {
            await folderStore.track(gid, discordUserId).catch(()=>{});
          }
        }
        
        if (myGroups.length === 0) {
          await interaction.editReply({ content: roblox ? `📁 Папка пуста для **${roblox}**. Скопируй группу на сайте — бот запомнит.` : `📁 Сначала \`/link ROBLOX_USERNAME\` или скопируй группу на сайте` });
          return;
        }
        // Загружаем сохраненные метаданные (названия и участников)
        const savedMetas = await folderStore.getAllGroupMetas();
        const groupInfos: { id: number; name: string; memberCount: number; description: string }[] = [];
        const missingIds: number[] = [];

        for (const gid of myGroups) {
          const meta = savedMetas[String(gid)];
          if (meta?.name) {
            groupInfos.push({
              id: gid,
              name: meta.name,
              memberCount: meta.memberCount ?? 0,
              description: '',
            });
          } else {
            missingIds.push(gid);
          }
        }

        if (missingIds.length > 0) {
          // Чанками по 5, чтобы не словить 429 от Roblox API
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
                    description: (info.description ?? '').slice(0, 90),
                  });
                  await folderStore.setGroupMeta(gid, {
                    name: info.name,
                    memberCount: info.memberCount ?? 0,
                  }).catch(() => {});
                } else {
                  groupInfos.push({ id: gid, name: `Group #${gid}`, memberCount: 0, description: '' });
                }
              } catch {
                groupInfos.push({ id: gid, name: `Group #${gid}`, memberCount: 0, description: '' });
              }
            }));
            if (i + 5 < missingIds.length) {
              await new Promise(r => setTimeout(r, 400));
            }
          }
        }

        // сортировка по members desc
        groupInfos.sort((a,b)=> b.memberCount - a.memberCount);
        const chunks: typeof groupInfos[] = [];
        for (let i=0;i<groupInfos.length;i+=25) chunks.push(groupInfos.slice(i,i+25));
        const embeds = chunks.map((chunk, idx) => new EmbedBuilder()
          .setColor(0xF59E0B)
          .setAuthor({ name: `Copied Folder — ${roblox ?? 'WornBy'}${chunks.length>1 ? ` (${idx+1}/${chunks.length})` : ''}` })
          .setTitle(idx===0 ? `📁 ${myGroups.length} groups tracked` : `📁 continued`)
          .setDescription(idx===0 ? `Для **${roblox ?? 'тебя'}** • авто-уведомления в DM при новых шмотках, снятии и возврате в продажу` : `…ещё ${chunk.length} групп`)
          .addFields(chunk.map(g => ({
            name: `${g.name}`.slice(0,256),
            value: `**${g.memberCount.toLocaleString()}** members · [\`#${g.id}\`](https://www.roblox.com/groups/${g.id})`,
            inline: true,
          })))
          .setFooter({ text: `WornBy • /track /untrack • Check new on site` })
          .setTimestamp(new Date()));
        try {
          await interaction.editReply({ embeds: embeds.slice(0,10) });
        } catch (e) {
          // fallback — если embed слишком большой (редкий 40060), шлём plain текст
          console.warn('[DiscordBot] folder embed fail', (e as Error).message);
          await interaction.editReply({ content: `📁 ${myGroups.length} groups: ${myGroups.map(id=>`#${id}`).join(', ')}` }).catch(()=>{});
        }
      } else if (interaction.commandName === 'track') {
        const gid = interaction.options.getInteger('group_id', true);
        await folderStore.track(gid, discordUserId);
        RobloxService.getGroupInfo(gid).then(async (info) => {
          if (info?.name) {
            await folderStore.setGroupMeta(gid, {
              name: info.name,
              memberCount: info.memberCount ?? 0,
            }).catch(() => {});
          }
        }).catch(() => {});
        // Сидим тихо: инициализируем кэш без спама — подтягиваем 1 новинку для lastItemId
        const seed = await import('./robloxService.js').then(m=> m.RobloxService.getAllGroupItems(gid, 30).then(d=> d[0]?.id ?? 0).catch(()=>0));
        if (seed) await folderStore.setLastItemId(gid, seed);
        // прогреваем itemStates в фоне чтобы след тик не триггерил бэкфилл
        import('./robloxService.js').then(async m=> { const items = await m.RobloxService.getAllGroupItems(gid, 120).catch(()=>[]); if (items.length) { const st: Record<string,{name:string;price:number|null;isForSale:boolean|null}> = {}; for (const it of items) st[String(it.id)] = { name: it.name, price: it.price, isForSale: it.isForSale }; await folderStore.setItemStates(gid, st); } }).catch(()=>{});
        await interaction.editReply({ content: `✅ Tracking **${gid}** — уведомления придут в DM при снятии/возврате в продажу и новинках.` });
      } else if (interaction.commandName === 'untrack') {
        const gid = interaction.options.getInteger('group_id', true);
        await folderStore.untrack(gid, discordUserId);
        await interaction.editReply({ content: `🗑️ Untracked **${gid}**` });
      }
    } catch (e) {
      console.warn('[DiscordBot] interaction err', (e as Error).message);
      if (interaction.isRepliable()) {
        const errorReply = interaction.deferred || interaction.replied
          ? interaction.editReply({ content: `❌ Error` })
          : interaction.reply({ content: `❌ Error`, flags: MessageFlags.Ephemeral });
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
  // вызывается вручную если хотим пуш сразу после Check new на сайте
  const subscribers = await folderStore.getSubscribers(groupId);
  if (subscribers.length===0) return;
  const groupInfo = await RobloxService.getGroupInfo(groupId).catch(()=> null);
  for (const uid of subscribers) await notifyDiscordUser(uid, groupId, groupInfo, item, 'NEW');
}

// Экспорт для тестов / ручного триггера
export { checkAllGroups };
