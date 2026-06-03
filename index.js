require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder
} = require("discord.js");

const { createClient } = require("@supabase/supabase-js");

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

const commands = [
    new SlashCommandBuilder()
        .setName("collection")
        .setDescription("Show collection")
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

    if (interaction.commandName === "collection") {

        try {

            await interaction.deferReply();

            const { data, error } = await supabase
                .from("creatures")
                .select("*");

            if (error) {
                return interaction.editReply(
                    "Database error: " + error.message
                );
            }

            if (!data || data.length === 0) {
                return interaction.editReply(
                    "📦 Collection is empty."
                );
            }

            let msg = "📦 Collection\n\n";

            data.forEach(row => {
                msg += `• ${row.creaturename}\n`;
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

client.login(process.env.DISCORD_TOKEN);