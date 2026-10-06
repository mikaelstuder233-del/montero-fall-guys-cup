import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Client, GatewayIntentBits, Events, PermissionsBitField,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder, REST, Routes, SlashCommandBuilder,
  LabelBuilder
} from "discord.js";
import pg from "pg";
const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "turnier-data.json");
const app = express();
const port = Number(process.env.PORT || 3000);
const maxPlayers = Number(process.env.MAX_PLAYERS || 32);

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
  : null;

if(!pool){
  console.error("❌ DATABASE_URL fehlt. Der Bot benötigt jetzt eine PostgreSQL-Datenbank.");
  process.exit(1);
}

async function initDatabase(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_registrations (
      id BIGSERIAL PRIMARY KEY,
      discord_id TEXT UNIQUE,
      discord_name TEXT,
      fallguys_name TEXT NOT NULL,
      email TEXT,
      source TEXT NOT NULL DEFAULT 'discord',
      swiss_residence BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tournament_registrations_created_at ON tournament_registrations(created_at)`);

  // Einmalige Migration vorhandener Testdaten aus der alten JSON-Datei.
  // Danach arbeitet der Bot ausschließlich mit PostgreSQL.
  if(fs.existsSync(DATA_FILE)){
    try{
      const raw=JSON.parse(fs.readFileSync(DATA_FILE,"utf8"));
      const registrations=Array.isArray(raw?.registrations) ? raw.registrations : [];
      const existing=await pool.query("SELECT COUNT(*)::int AS count FROM tournament_registrations");
      if(existing.rows[0].count===0 && registrations.length){
        for(const r of registrations){
          await pool.query(`
            INSERT INTO tournament_registrations
              (discord_id, discord_name, fallguys_name, email, source, swiss_residence, created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (discord_id) DO NOTHING
          `,[
            r.discord_id || null,
            r.discord_name || null,
            r.fallguys_name || "Unbekannt",
            r.email || null,
            r.source || "migration",
            true,
            r.created_at || new Date().toISOString()
          ]);
        }
        console.log(`📦 ${registrations.length} vorhandene Anmeldung(en) aus JSON migriert.`);
      }
    }catch(e){
      console.warn("⚠️ Alte JSON-Daten konnten nicht migriert werden:",e.message);
    }
  }
  console.log("✅ PostgreSQL-Datenbank bereit.");
}

async function countPlayers(){
  const result=await pool.query("SELECT COUNT(*)::int AS count FROM tournament_registrations");
  return result.rows[0].count;
}

async function isRegistered(discordId){
  if(!discordId) return false;
  const result=await pool.query("SELECT 1 FROM tournament_registrations WHERE discord_id=$1 LIMIT 1",[discordId]);
  return result.rowCount>0;
}

async function addRegistration({discordId=null,discordName=null,fallGuysName,email=null,source,swissResidence=false}){
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    // Verhindert, dass zwei gleichzeitige Anmeldungen den Platz 32 überschreiten.
    await client.query("SELECT pg_advisory_xact_lock($1)",[9262026]);
    const countResult=await client.query("SELECT COUNT(*)::int AS count FROM tournament_registrations");
    if(countResult.rows[0].count>=maxPlayers){
      await client.query("ROLLBACK");
      return {ok:false,reason:"full"};
    }
    if(discordId){
      const duplicate=await client.query("SELECT 1 FROM tournament_registrations WHERE discord_id=$1 LIMIT 1",[discordId]);
      if(duplicate.rowCount){
        await client.query("ROLLBACK");
        return {ok:false,reason:"already"};
      }
    }
    const result=await client.query(`
      INSERT INTO tournament_registrations
        (discord_id, discord_name, fallguys_name, email, source, swiss_residence)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING id
    `,[discordId,discordName,fallGuysName.trim(),email?.trim() || null,source,Boolean(swissResidence)]);
    await client.query("COMMIT");
    return {ok:true,id:result.rows[0].id};
  }catch(e){
    await client.query("ROLLBACK").catch(()=>{});
    console.error("Anmeldung konnte nicht gespeichert werden:",e);
    return {ok:false,reason:"error"};
  }finally{
    client.release();
  }
}

async function getParticipants(){
  const result=await pool.query(`
    SELECT id, discord_id, discord_name, fallguys_name, email, source, swiss_residence, created_at
    FROM tournament_registrations
    ORDER BY id ASC
  `);
  return result.rows;
}

async function resetTournament(){
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)",[9262026]);
    const result=await client.query("SELECT id, discord_id FROM tournament_registrations ORDER BY id ASC");
    await client.query("DELETE FROM tournament_registrations");
    await client.query("COMMIT");
    return result.rows;
  }catch(e){
    await client.query("ROLLBACK").catch(()=>{});
    throw e;
  }finally{
    client.release();
  }
}

app.use((req,res,next)=>{
  const origin=req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary","Origin");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  if(req.method==="OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname,"public")));

app.get("/api/status",async (req,res)=>{
  const count=await countPlayers();
  res.json({
    event:"Montéro Fall Guys Cup 2026",
    date:process.env.TOURNAMENT_DATE||"30.10.2026",
    time:process.env.TOURNAMENT_TIME||"19:00",
    maxPlayers, registered:count,
    remaining:Math.max(0,maxPlayers-count),
    open:count<maxPlayers
  });
});
app.post("/api/register",async (req,res)=>{
  const {fallGuysName,email}=req.body||{};
  if(!fallGuysName || fallGuysName.trim().length<2)
    return res.status(400).json({ok:false,message:"Bitte gib deinen Fall-Guys-Namen ein."});
  const result=await addRegistration({fallGuysName,email,source:"website",swissResidence:true});
  if(!result.ok){
    const messages={full:"Das Turnier ist bereits voll.",already:"Du bist bereits registriert."};
    return res.status(409).json({ok:false,message:messages[result.reason]||"Anmeldung nicht möglich."});
  }
  res.json({ok:true,message:"Du bist erfolgreich für den Montéro Fall Guys Cup registriert!",playerNumber:await countPlayers()});
});
app.get("/api/admin/participants",async (req,res)=>{
  if(!process.env.ADMIN_KEY || req.query.key!==process.env.ADMIN_KEY)
    return res.status(401).json({ok:false,message:"Nicht autorisiert."});
  const participants=await getParticipants();
  res.json({ok:true,count:participants.length,maxPlayers,participants});
});

const client=new Client({intents:[GatewayIntentBits.Guilds]});
const registerButton=new ButtonBuilder()
  .setCustomId("montero_register").setLabel("🎮 JETZT ANMELDEN").setStyle(ButtonStyle.Success);
const registerRow=new ActionRowBuilder().addComponents(registerButton);

async function buildTournamentEmbed(){
  const count=await countPlayers();
  return new EmbedBuilder()
    .setColor(0xC8A45D)
    .setTitle("🏆 MONTÉRO FALL GUYS CUP 2026")
    .setDescription(
      "**30. Oktober 2026 · 19:00 Uhr**\n\n"+
      "Bist du bereit für den ersten Montéro Fall Guys Cup?\n\n"+
      `👥 **Teilnehmer:** ${count}/${maxPlayers}\n`+
      "🎮 **Spiel:** Fall Guys\n"+
      "📺 **LIVE:** MIKKI_TV auf Twitch\n\n"+
      "Klicke auf **JETZT ANMELDEN**, fülle das kurze Formular aus und du bist dabei.\n\n"+
      "⚠️ *Bei längerer Inaktivität kann der Bot kurz schlafen. Falls die Anmeldung nicht reagiert, bitte 1–2 Minuten warten und erneut versuchen.*"
    )
    .addFields(
      {name:"🥇 1. Platz",value:"Montéro Preis + Pokal",inline:true},
      {name:"🥈 2. Platz",value:"Montéro Gutschein",inline:true},
      {name:"🥉 3. Platz",value:"Montéro Gutschein",inline:true}
    )
    .setFooter({text:"Montéro · Born in Switzerland"});
}

async function refreshPanelMessage(channel){
  const messages=await channel.messages.fetch({limit:50});
  const panel=messages.find(m=>m.author.id===client.user.id &&
    m.components?.some(row=>row.components?.some(c=>c.customId==="montero_register")));
  if(panel) await panel.edit({embeds:[await buildTournamentEmbed()],components:[registerRow]});
}

client.once(Events.ClientReady,async readyClient=>{
  console.log(`Discord bot online: ${readyClient.user.tag}`);
  const commands=[
    new SlashCommandBuilder().setName("turnier-panel")
      .setDescription("Postet das Montéro Fall Guys Anmeldepanel in diesen Channel."),
    new SlashCommandBuilder().setName("teilnehmer")
      .setDescription("Zeigt die aktuelle Anzahl der Turnierteilnehmer."),
    new SlashCommandBuilder().setName("turnier-reset")
      .setDescription("Setzt den Turnierstand auf 0 zurück und entfernt die Teilnehmerrollen.")
  ].map(c=>c.toJSON());

  const rest=new REST({version:"10"}).setToken(process.env.DISCORD_TOKEN);
  try{
    if(process.env.DISCORD_GUILD_ID){
      await rest.put(
        Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID,process.env.DISCORD_GUILD_ID),
        {body:commands}
      );
      console.log("Slash-Befehle registriert.");
    }
  }catch(e){console.error("Slash-Commands konnten nicht registriert werden:",e);}
});

client.on(Events.InteractionCreate,async interaction=>{
  try{
    if(interaction.isChatInputCommand()){
      if(interaction.commandName==="turnier-panel")
        return interaction.reply({embeds:[await buildTournamentEmbed()],components:[registerRow]});
      if(interaction.commandName==="teilnehmer")
        return interaction.reply({content:`🏆 **Montéro Cup:** ${await countPlayers()}/${maxPlayers} Plätze belegt.`,ephemeral:true});

      if(interaction.commandName==="turnier-reset"){
        if(!interaction.guild)
          return interaction.reply({content:"❌ Dieser Befehl funktioniert nur auf dem Turnier-Server.",ephemeral:true});

        if(!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator))
          return interaction.reply({content:"❌ Nur Server-Administratoren dürfen das Turnier zurücksetzen.",ephemeral:true});

        const oldParticipants=await resetTournament();

        let removedRoles=0;
        if(process.env.DISCORD_PARTICIPANT_ROLE_ID){
          for(const participant of oldParticipants){
            if(!participant.discord_id) continue;
            const member=await interaction.guild.members.fetch(participant.discord_id).catch(()=>null);
            if(member?.roles.cache.has(process.env.DISCORD_PARTICIPANT_ROLE_ID)){
              const removed=await member.roles.remove(process.env.DISCORD_PARTICIPANT_ROLE_ID).then(()=>true).catch(()=>false);
              if(removed) removedRoles++;
            }
          }
        }

        await interaction.reply({
          content:`🧹 **Turnier zurückgesetzt!**\n\n👥 Teilnehmer: **0/${maxPlayers}**\n🏆 Entfernte Teilnehmerrollen: **${removedRoles}**\n\nAlle bisherigen Anmeldungen wurden gelöscht.`,
          ephemeral:true
        });

        if(interaction.channel) await refreshPanelMessage(interaction.channel).catch(()=>{});
      }
    }

    if(interaction.isButton() && interaction.customId==="montero_register"){
      if(await countPlayers()>=maxPlayers)
        return interaction.reply({content:"❌ Das Turnier ist leider bereits voll.",ephemeral:true});
      if(await isRegistered(interaction.user.id))
        return interaction.reply({content:"✅ Du bist bereits registriert!",ephemeral:true});

      const modal=new ModalBuilder().setCustomId("montero_registration_modal").setTitle("Montéro Fall Guys Cup");
      const fg=new TextInputBuilder().setCustomId("fallguys_name").setLabel("Dein Fall-Guys-Name")
        .setPlaceholder("z. B. MIKKI123").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50);
      const email=new TextInputBuilder().setCustomId("email").setLabel("E-Mail für die Turnierinfo")
        .setPlaceholder("optional").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100);

      // Pflichtbestätigung für den Schweizer Wohnsitz.
      // Discord stellt Checkbox-Komponenten in Modals bereit.
      const swissResidence = new LabelBuilder()
        .setLabel("🇨🇭 Wohnsitz Schweiz")
        .setDescription("Ich bestätige, dass ich zum Zeitpunkt der Anmeldung meinen Wohnsitz in der Schweiz habe.")
        .setCheckboxComponent((checkbox) => checkbox.setCustomId("swiss_residence"));

      modal.addComponents(
        new ActionRowBuilder().addComponents(fg),
        new ActionRowBuilder().addComponents(email),
        swissResidence
      );
      return interaction.showModal(modal);
    }

    if(interaction.isModalSubmit() && interaction.customId==="montero_registration_modal"){
      const fallGuysName=interaction.fields.getTextInputValue("fallguys_name");
      const email=interaction.fields.getTextInputValue("email")||null;
      const swissResidence = interaction.fields.getCheckbox("swiss_residence");
      if(!swissResidence?.value){
        return interaction.reply({
          content:"🇨🇭 Du musst bestätigen, dass du deinen Wohnsitz in der Schweiz hast, um am Turnier teilzunehmen.",
          ephemeral:true
        });
      }
      const result=await addRegistration({
        discordId:interaction.user.id,discordName:interaction.user.username,
        fallGuysName,email,source:"discord",swissResidence:true
      });
      if(!result.ok){
        const messages={full:"❌ Das Turnier ist inzwischen voll.",already:"✅ Du bist bereits registriert."};
        return interaction.reply({content:messages[result.reason]||"❌ Anmeldung fehlgeschlagen.",ephemeral:true});
      }
      if(process.env.DISCORD_PARTICIPANT_ROLE_ID && interaction.guild){
        const member=await interaction.guild.members.fetch(interaction.user.id).catch(()=>null);
        if(member) await member.roles.add(process.env.DISCORD_PARTICIPANT_ROLE_ID).catch(()=>{});
      }
      await interaction.reply({
        content:`🎉 **Du bist dabei!**\n\nMontéro Fall Guys Cup 2026\n📅 30.10.2026 · 19:00 Uhr\n🎮 ${fallGuysName}\n👥 Startplatz: ${await countPlayers()}/${maxPlayers}`,
        ephemeral:true
      });
      if(interaction.channel) await refreshPanelMessage(interaction.channel).catch(()=>{});
    }
  }catch(err){
    console.error(err);
    if(interaction.isRepliable() && !interaction.replied && !interaction.deferred)
      await interaction.reply({content:"❌ Es ist ein Fehler aufgetreten. Bitte versuche es erneut.",ephemeral:true}).catch(()=>{});
  }
});

await initDatabase();

app.listen(port,()=>console.log(`Website läuft auf Port ${port}`));

if(process.env.DISCORD_TOKEN) client.login(process.env.DISCORD_TOKEN);
else console.warn("DISCORD_TOKEN fehlt – Website läuft trotzdem.");
