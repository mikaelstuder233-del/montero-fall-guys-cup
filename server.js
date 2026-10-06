import "dotenv/config";
import express from "express";
import Database from "better-sqlite3";
import {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";

const app = express();

app.use((req, res, next) => {
  const origin = req.headers.origin;
  // For a public tournament signup endpoint, allow browser calls from Shopify.
  // In production, replace "*" with https://monteroclothing.ch for tighter security.
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
const port = Number(process.env.PORT || 3000);
const maxPlayers = Number(process.env.MAX_PLAYERS || 32);

const db = new Database("turnier.sqlite");
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT UNIQUE,
    discord_name TEXT,
    fallguys_name TEXT NOT NULL,
    email TEXT,
    source TEXT NOT NULL DEFAULT 'website',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

function countPlayers() {
  return db.prepare("SELECT COUNT(*) AS count FROM registrations").get().count;
}

function isRegistered(discordId) {
  return !!db.prepare("SELECT 1 FROM registrations WHERE discord_id = ?").get(discordId);
}

function addRegistration({ discordId = null, discordName = null, fallGuysName, email = null, source }) {
  if (countPlayers() >= maxPlayers) {
    return { ok: false, reason: "full" };
  }
  if (discordId && isRegistered(discordId)) {
    return { ok: false, reason: "already" };
  }
  try {
    const stmt = db.prepare(`
      INSERT INTO registrations (discord_id, discord_name, fallguys_name, email, source)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(discordId, discordName, fallGuysName.trim(), email?.trim() || null, source);
    return { ok: true, id: result.lastInsertRowid };
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) return { ok: false, reason: "already" };
    throw err;
  }
}

app.get("/api/status", (req, res) => {
  const count = countPlayers();
  res.json({
    event: "Montéro Fall Guys Cup 2026",
    date: process.env.TOURNAMENT_DATE || "30.10.2026",
    time: process.env.TOURNAMENT_TIME || "19:00",
    maxPlayers,
    registered: count,
    remaining: Math.max(0, maxPlayers - count),
    open: count < maxPlayers
  });
});

app.post("/api/register", (req, res) => {
  const { fallGuysName, email } = req.body || {};
  if (!fallGuysName || fallGuysName.trim().length < 2) {
    return res.status(400).json({ ok: false, message: "Bitte gib deinen Fall-Guys-Namen ein." });
  }

  const result = addRegistration({
    fallGuysName,
    email,
    source: "website"
  });

  if (!result.ok) {
    const messages = {
      full: "Das Turnier ist bereits voll.",
      already: "Du bist bereits registriert."
    };
    return res.status(409).json({ ok: false, message: messages[result.reason] || "Anmeldung nicht möglich." });
  }

  res.json({
    ok: true,
    message: "Du bist erfolgreich für den Montéro Fall Guys Cup registriert!",
    playerNumber: countPlayers()
  });
});

app.get("/api/admin/participants", (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ ok: false, message: "Nicht autorisiert." });
  }
  const rows = db.prepare(`
    SELECT id, discord_name, fallguys_name, email, source, created_at
    FROM registrations
    ORDER BY id ASC
  `).all();
  res.json({ ok: true, count: rows.length, maxPlayers, participants: rows });
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const registerButton = new ButtonBuilder()
  .setCustomId("montero_register")
  .setLabel("🎮 JETZT ANMELDEN")
  .setStyle(ButtonStyle.Success);

const registerRow = new ActionRowBuilder().addComponents(registerButton);

function buildTournamentEmbed() {
  const count = countPlayers();
  return new EmbedBuilder()
    .setColor(0xC8A45D)
    .setTitle("🏆 MONTÉRO FALL GUYS CUP 2026")
    .setDescription(
      "**30. Oktober 2026 · 19:00 Uhr**\n\n" +
      "Bist du bereit für den ersten Montéro Fall Guys Cup?\n\n" +
      `👥 **Teilnehmer:** ${count}/${maxPlayers}\n` +
      `🎮 **Spiel:** Fall Guys\n` +
      "📺 **LIVE:** MIKKI_TV auf Twitch\n\n" +
      "Klicke auf **JETZT ANMELDEN**, fülle das kurze Formular aus und du bist dabei."
    )
    .addFields(
      { name: "🥇 1. Platz", value: "Montéro Preis + Gewinner-Titel", inline: true },
      { name: "🥈 2. Platz", value: "Montéro Gutschein", inline: true },
      { name: "🥉 3. Platz", value: "Montéro Gutschein", inline: true }
    )
    .setFooter({ text: "Montéro · Born in Switzerland" });
}

async function refreshPanelMessage(channel) {
  const messages = await channel.messages.fetch({ limit: 50 });
  const panel = messages.find(m => m.author.id === client.user.id && m.components?.some(row =>
    row.components?.some(c => c.customId === "montero_register")
  ));
  if (panel) await panel.edit({ embeds: [buildTournamentEmbed()], components: [registerRow] });
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Discord bot online: ${readyClient.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName("turnier-panel")
      .setDescription("Postet das Montéro Fall Guys Anmeldepanel in diesen Channel."),
    new SlashCommandBuilder()
      .setName("teilnehmer")
      .setDescription("Zeigt die aktuelle Anzahl der Turnierteilnehmer.")
  ].map(c => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    if (process.env.DISCORD_GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
        { body: commands }
      );
    }
  } catch (e) {
    console.error("Slash-Commands konnten nicht registriert werden:", e);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "turnier-panel") {
        await interaction.reply({
          embeds: [buildTournamentEmbed()],
          components: [registerRow]
        });
      }

      if (interaction.commandName === "teilnehmer") {
        await interaction.reply({
          content: `🏆 **Montéro Cup:** ${countPlayers()}/${maxPlayers} Plätze belegt.`,
          ephemeral: true
        });
      }
      return;
    }

    if (interaction.isButton() && interaction.customId === "montero_register") {
      if (countPlayers() >= maxPlayers) {
        return interaction.reply({ content: "❌ Das Turnier ist leider bereits voll.", ephemeral: true });
      }
      if (isRegistered(interaction.user.id)) {
        return interaction.reply({ content: "✅ Du bist bereits registriert!", ephemeral: true });
      }

      const modal = new ModalBuilder()
        .setCustomId("montero_registration_modal")
        .setTitle("Montéro Fall Guys Cup");

      const fallGuysInput = new TextInputBuilder()
        .setCustomId("fallguys_name")
        .setLabel("Dein Fall-Guys-Name")
        .setPlaceholder("z. B. MIKKI123")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(50);

      const emailInput = new TextInputBuilder()
        .setCustomId("email")
        .setLabel("E-Mail für die Turnierinfo")
        .setPlaceholder("optional")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(100);

      modal.addComponents(
        new ActionRowBuilder().addComponents(fallGuysInput),
        new ActionRowBuilder().addComponents(emailInput)
      );

      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === "montero_registration_modal") {
      const fallGuysName = interaction.fields.getTextInputValue("fallguys_name");
      const email = interaction.fields.getTextInputValue("email") || null;

      const result = addRegistration({
        discordId: interaction.user.id,
        discordName: interaction.user.username,
        fallGuysName,
        email,
        source: "discord"
      });

      if (!result.ok) {
        const messages = {
          full: "❌ Das Turnier ist inzwischen voll.",
          already: "✅ Du bist bereits registriert."
        };
        return interaction.reply({ content: messages[result.reason] || "❌ Anmeldung fehlgeschlagen.", ephemeral: true });
      }

      if (process.env.DISCORD_PARTICIPANT_ROLE_ID && interaction.guild) {
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (member) await member.roles.add(process.env.DISCORD_PARTICIPANT_ROLE_ID).catch(() => {});
      }

      await interaction.reply({
        content: `🎉 **Du bist dabei!**\n\nMontéro Fall Guys Cup 2026\n📅 30.10.2026 · 19:00 Uhr\n🎮 ${fallGuysName}\n👥 Startplatz: ${countPlayers()}/${maxPlayers}`,
        ephemeral: true
      });

      if (interaction.channel) await refreshPanelMessage(interaction.channel).catch(() => {});
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Es ist ein Fehler aufgetreten. Bitte versuche es erneut.", ephemeral: true }).catch(() => {});
    }
  }
});

app.listen(port, () => {
  console.log(`Website läuft auf http://localhost:${port}`);
});

if (process.env.DISCORD_TOKEN) {
  client.login(process.env.DISCORD_TOKEN);
} else {
  console.warn("DISCORD_TOKEN fehlt – Website läuft trotzdem.");
}
