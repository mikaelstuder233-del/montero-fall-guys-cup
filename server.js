
import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Client, GatewayIntentBits, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder, REST, Routes, SlashCommandBuilder,
  LabelBuilder
} from "discord.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "turnier-data.json");
const app = express();
const port = Number(process.env.PORT || 3000);
const maxPlayers = Number(process.env.MAX_PLAYERS || 32);

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

function loadData(){
  try {
    if(!fs.existsSync(DATA_FILE)) return {registrations:[]};
    return JSON.parse(fs.readFileSync(DATA_FILE,"utf8"));
  } catch(e) {
    console.error("Daten konnten nicht gelesen werden:",e);
    return {registrations:[]};
  }
}
function saveData(data){
  fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2), "utf8");
}
function countPlayers(){ return loadData().registrations.length; }
function isRegistered(discordId){
  if(!discordId) return false;
  return loadData().registrations.some(r=>r.discord_id===discordId);
}
function addRegistration({discordId=null,discordName=null,fallGuysName,email=null,source}){
  const data=loadData();
  if(data.registrations.length>=maxPlayers) return {ok:false,reason:"full"};
  if(discordId && data.registrations.some(r=>r.discord_id===discordId))
    return {ok:false,reason:"already"};
  const row={
    id: data.registrations.length ? Math.max(...data.registrations.map(r=>r.id))+1 : 1,
    discord_id:discordId,
    discord_name:discordName,
    fallguys_name:fallGuysName.trim(),
    email:email?.trim() || null,
    source,
    created_at:new Date().toISOString()
  };
  data.registrations.push(row);
  saveData(data);
  return {ok:true,id:row.id};
}

app.get("/api/status",(req,res)=>{
  const count=countPlayers();
  res.json({
    event:"Montéro Fall Guys Cup 2026",
    date:process.env.TOURNAMENT_DATE||"30.10.2026",
    time:process.env.TOURNAMENT_TIME||"19:00",
    maxPlayers, registered:count,
    remaining:Math.max(0,maxPlayers-count),
    open:count<maxPlayers
  });
});
app.post("/api/register",(req,res)=>{
  const {fallGuysName,email}=req.body||{};
  if(!fallGuysName || fallGuysName.trim().length<2)
    return res.status(400).json({ok:false,message:"Bitte gib deinen Fall-Guys-Namen ein."});
  const result=addRegistration({fallGuysName,email,source:"website"});
  if(!result.ok){
    const messages={full:"Das Turnier ist bereits voll.",already:"Du bist bereits registriert."};
    return res.status(409).json({ok:false,message:messages[result.reason]||"Anmeldung nicht möglich."});
  }
  res.json({ok:true,message:"Du bist erfolgreich für den Montéro Fall Guys Cup registriert!",playerNumber:countPlayers()});
});
app.get("/api/admin/participants",(req,res)=>{
  if(!process.env.ADMIN_KEY || req.query.key!==process.env.ADMIN_KEY)
    return res.status(401).json({ok:false,message:"Nicht autorisiert."});
  const participants=loadData().registrations;
  res.json({ok:true,count:participants.length,maxPlayers,participants});
});

const client=new Client({intents:[GatewayIntentBits.Guilds]});
const registerButton=new ButtonBuilder()
  .setCustomId("montero_register").setLabel("🎮 JETZT ANMELDEN").setStyle(ButtonStyle.Success);
const registerRow=new ActionRowBuilder().addComponents(registerButton);

function buildTournamentEmbed(){
  const count=countPlayers();
  return new EmbedBuilder()
    .setColor(0xC8A45D)
    .setTitle("🏆 MONTÉRO FALL GUYS CUP 2026")
    .setDescription(
      "**30. Oktober 2026 · 19:00 Uhr**\n\n"+
      "Bist du bereit für den ersten Montéro Fall Guys Cup?\n\n"+
      `👥 **Teilnehmer:** ${count}/${maxPlayers}\n`+
      "🎮 **Spiel:** Fall Guys\n"+
      "📺 **LIVE:** MIKKI_TV auf Twitch\n\n"+
      "Klicke auf **JETZT ANMELDEN**, fülle das kurze Formular aus und du bist dabei."
    )
    .addFields(
      {name:"🥇 1. Platz",value:"Montéro Preis + Gewinner-Titel",inline:true},
      {name:"🥈 2. Platz",value:"Montéro Gutschein",inline:true},
      {name:"🥉 3. Platz",value:"Montéro Gutschein",inline:true}
    )
    .setFooter({text:"Montéro · Born in Switzerland"});
}

async function refreshPanelMessage(channel){
  const messages=await channel.messages.fetch({limit:50});
  const panel=messages.find(m=>m.author.id===client.user.id &&
    m.components?.some(row=>row.components?.some(c=>c.customId==="montero_register")));
  if(panel) await panel.edit({embeds:[buildTournamentEmbed()],components:[registerRow]});
}

client.once(Events.ClientReady,async readyClient=>{
  console.log(`Discord bot online: ${readyClient.user.tag}`);
  const commands=[
    new SlashCommandBuilder().setName("turnier-panel")
      .setDescription("Postet das Montéro Fall Guys Anmeldepanel in diesen Channel."),
    new SlashCommandBuilder().setName("teilnehmer")
      .setDescription("Zeigt die aktuelle Anzahl der Turnierteilnehmer.")
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
        return interaction.reply({embeds:[buildTournamentEmbed()],components:[registerRow]});
      if(interaction.commandName==="teilnehmer")
        return interaction.reply({content:`🏆 **Montéro Cup:** ${countPlayers()}/${maxPlayers} Plätze belegt.`,ephemeral:true});
    }

    if(interaction.isButton() && interaction.customId==="montero_register"){
      if(countPlayers()>=maxPlayers)
        return interaction.reply({content:"❌ Das Turnier ist leider bereits voll.",ephemeral:true});
      if(isRegistered(interaction.user.id))
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
      const result=addRegistration({
        discordId:interaction.user.id,discordName:interaction.user.username,
        fallGuysName,email,source:"discord"
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
        content:`🎉 **Du bist dabei!**\n\nMontéro Fall Guys Cup 2026\n📅 30.10.2026 · 19:00 Uhr\n🎮 ${fallGuysName}\n👥 Startplatz: ${countPlayers()}/${maxPlayers}`,
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

app.listen(port,()=>console.log(`Website läuft auf Port ${port}`));

if(process.env.DISCORD_TOKEN) client.login(process.env.DISCORD_TOKEN);
else console.warn("DISCORD_TOKEN fehlt – Website läuft trotzdem.");
