require("dotenv").config();

const express = require("express");
const app = express();

const fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args));

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder
} = require("discord.js");

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

app.get("/", (req, res) => {
    res.send("ProjectB Bot Alive");
});

app.get("/login", (req, res) => {

    const robloxId = req.query.robloxId;

    const url =
        "https://discord.com/api/oauth2/authorize" +
        "?client_id=" + process.env.CLIENT_ID +
        "&redirect_uri=" + encodeURIComponent(process.env.REDIRECT_URI) +
        "&response_type=code" +
        "&scope=identify" +
        "&state=" + robloxId;

    res.redirect(url);
});

app.get("/callback", async (req, res) => {

    const code = req.query.code;
    const robloxId = req.query.state;

    if (!code) {
        return res.send("No code received.");
    }

    try {

        const tokenResponse = await fetch(
            "https://discord.com/api/oauth2/token",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: new URLSearchParams({
                    client_id: process.env.CLIENT_ID,
                    client_secret: process.env.DISCORD_CLIENT_SECRET,
                    grant_type: "authorization_code",
                    code: code,
                    redirect_uri: process.env.REDIRECT_URI
                })
            }
        );

        const tokenData = await tokenResponse.json();

        console.log("TOKEN DATA:", tokenData);

        const userResponse = await fetch(
            "https://discord.com/api/users/@me",
            {
                headers: {
                    Authorization: `Bearer ${tokenData.access_token}`
                }
            }
        );

        const user = await userResponse.json();

        console.log("USER DATA:", user);

        await supabase
            .from("discord_links")
            .upsert({
                roblox_user_id: robloxId,
                discord_user_id: user.id,
                discord_username: user.username
            });

        console.log(
            "LINK SAVED:",
            robloxId,
            user.id,
            user.username
        );

        res.send(`
            <h1>Discord Linked ✅</h1>
            <p>${user.username}</p>
            <p>Discord ID: ${user.id}</p>
        `);

    } catch (err) {

        console.error("OAUTH ERROR:", err);

        res.send("OAuth failed.");
    }
});

app.listen(process.env.PORT || 3000, () => {
    console.log("Web server running");
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const commands = [
    new SlashCommandBuilder()
        .setName("collection")
        .setDescription("Show collection")
        .toJSON(),

    new SlashCommandBuilder()
        .setName("connect")
        .setDescription("Link Roblox account")
        .addStringOption(option =>
            option
                .setName("code")
                .setDescription("Your link code")
                .setRequired(true)
        )
        .toJSON()
];

client.once("ready", async () => {

    console.log(`Logged in as ${client.user.tag}`);

    const rest = new REST({ version: "10" })
        .setToken(process.env.DISCORD_TOKEN);

    try {

        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands }
        );

        console.log("Slash command registered");

    } catch (err) {

        console.error(err);
    }
});

client.on("interactionCreate", async (interaction) => {

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "connect") {

        const code =
            interaction.options.getString("code");

        return interaction.reply(
            `Checking code: ${code}`
        );
    }

    if (interaction.commandName === "collection") {

        try {

            await interaction.deferReply();

            const discordId =
                interaction.user.id;

            const { data: linkData, error: linkError } =
                await supabase
                    .from("discord_links")
                    .select("*")
                    .eq("discord_user_id", discordId)
                    .single();

            if (linkError || !linkData) {

                return interaction.editReply(
                    "❌ Discord account not linked."
                );
            }

            const robloxId =
                linkData.roblox_user_id;

            const { data, error } =
                await supabase
                    .from("creatures")
                    .select("*")
                    .eq("userid", String(robloxId));

            if (error) {

                return interaction.editReply(
                    "Database error: " +
                    error.message
                );
            }

            if (!data || data.length === 0) {

                return interaction.editReply(
                    "📦 Collection is empty."
                );
            }

            let msg =
                "📦 Your Collection\n\n";

            data.forEach(row => {

                msg +=
                    `• ${row.creaturename}\n`;

            });

            await interaction.editReply(msg);

        } catch (err) {

            console.error(err);

            try {

                await interaction.editReply(
                    "Something went wrong."
                );

            } catch {}
        }
    }
});

client.on("messageCreate", async (message) => {

    if (message.author.bot) return;

    if (!message.mentions.has(client.user)) return;

    const content = message.content
        .replace(`<@${client.user.id}>`, "")
        .replace(`<@!${client.user.id}>`, "")
        .trim();

    const match =
        content.match(/^connect\s+(.+)$/i);

    if (!match) {

        return message.reply(
            "❌ Invalid format.\nUse:\nConnect PJB-XXXX-XXXX-XXXX"
        );
    }

    const code = match[1].trim();

    await message.reply(
        `Checking code: ${code}`
    );

});

client.login(process.env.DISCORD_TOKEN);
