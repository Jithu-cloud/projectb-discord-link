require("dotenv").config();

const express = require("express");
const app = express();

const fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args));

const {Client,GatewayIntentBits,REST,Routes,SlashCommandBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,EmbedBuilder} = require("discord.js");

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL,process.env.SUPABASE_KEY);

// Pagination state management with auto-cleanup
const userPages = new Map();

// Cleanup function for pagination
function cleanupUserPages(userId) {
    setTimeout(() => {
        userPages.delete(userId);
        console.log(`Cleaned up pagination for user ${userId}`);
    }, 300000);
}

// Helper function to get Roblox username from ID
async function getRobloxUsername(robloxId) {
    try {
        const response = await fetch(
            `https://users.roblox.com/v1/users/${robloxId}`
        );

        const data = await response.json();

        return data.name || "Unknown";

    } catch (err) {

        console.error(
            "Failed to fetch Roblox username:",
            err
        );

        return "Unknown";
    }
}

// Helper function to validate and check code expiration
async function validateAndCheckCode(code, context) {

    const {
        data: codeData,
        error: codeError
    } = await supabase
        .from("link_codes")
        .select("*")
        .eq("code", code)
        .single();

    if (codeError || !codeData) {
        return {
            valid: false,
            error: "❌ Invalid Code"
        };
    }

    if (
        codeData.expires_at &&
        new Date(codeData.expires_at) < new Date()
    ) {

        await supabase
            .from("link_codes")
            .update({
                status: "EXPIRED"
            })
            .eq("code", code);

        return {
            valid: false,
            error: "❌ Code Expired"
        };
    }

    if (codeData.status !== "ACTIVE") {
        return {
            valid: false,
            error: `❌ Code Status: ${codeData.status}`
        };
    }

    return {
        valid: true,
        codeData
    };
}

app.get("/", (req, res) => {res.send("ProjectB Bot Alive");});

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

    // OAuth now requires a valid code too - generate a temporary code for OAuth linking
    // This ensures the A-System is respected
    const tempCode = `OAUTH-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    
    // Create a temporary ACTIVE code for this OAuth session
    await supabase
        .from("link_codes")
        .insert({
            code: tempCode,
            roblox_user_id: robloxId,
            status: "ACTIVE",
            expires_at: new Date(Date.now() + 10 * 60 * 1000) // 10 minutes expiry
        });

    // Now validate it through the same system
    const validation = await validateAndCheckCode(tempCode, "oauth");
    
    if (!validation.valid) {
        return res.send(`<h1>❌ Link Failed</h1><p>${validation.error}</p>`);
    }

    const robloxUsername = await getRobloxUsername(robloxId);

    // CHECK IF DISCORD ALREADY LINKED
    const { data: existingDiscord } =
        await supabase
            .from("discord_links")
            .select("*")
            .eq("discord_user_id", user.id)
            .single();

    if (existingDiscord) {
        return res.send("<h1>❌ Link Failed</h1><p>This Discord account is already linked to another Roblox account.</p>");
    }

    // CHECK IF ROBLOX ALREADY LINKED
    const { data: existingRoblox } =
        await supabase
            .from("discord_links")
            .select("*")
            .eq("roblox_user_id", robloxId)
            .single();

    if (existingRoblox) {
        return res.send("<h1>❌ Link Failed</h1><p>This Roblox account is already linked to another Discord account.</p>");
    }

    await supabase
        .from("discord_links")
        .insert({
            roblox_user_id: robloxId,
            roblox_username: robloxUsername,
            discord_user_id: user.id,
            discord_username: user.username,
            linked_by_code: tempCode
        });

    // MARK CODE USED
    await supabase
        .from("link_codes")
        .update({
            status: "USED",
            used_by_discord_id: user.id,
            used_at: new Date().toISOString()
        })
        .eq("code", tempCode);

    // AUDIT LOG
    await supabase
        .from("audit_logs")
        .insert({
            event_type: "LINK_SUCCESS_OAUTH",
            roblox_user_id: robloxId,
            roblox_username: robloxUsername,
            discord_user_id: user.id,
            discord_username: user.username,
            code: tempCode
        });

    console.log(
        "LINK SAVED:",
        robloxId,
        robloxUsername,
        user.id,
        user.username
    );

    res.send(`
        <h1>✅ Discord Linked Successfully</h1>
        <p>Roblox: ${robloxUsername}</p>
        <p>Discord: ${user.username}</p>
        <p>You can now close this window and return to Discord.</p>
    `);

} catch (err) {

    console.error("OAUTH ERROR:", err);

    res.send("<h1>❌ OAuth failed.</h1><p>Please try again later.</p>");
}

});

app.listen(process.env.PORT || 3000, () => {
    console.log("Web server running");
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent
    ]
});

const commands = [new SlashCommandBuilder().setName("collection").setDescription("Show collection").toJSON(),

new SlashCommandBuilder()
    .setName("connect")
    .setDescription("Link Roblox account")
    .addStringOption(option =>
        option
            .setName("code")
            .setDescription("Your link code")
            .setRequired(true)
    )
    .toJSON(),

new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Unlink Roblox account")
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

    console.log("Slash commands registered");

} catch (err) {

    console.error(err);
}

});

client.on("interactionCreate", async (interaction) => {

if (!interaction.isChatInputCommand()) return;

if (interaction.commandName === "connect") {

    const code = interaction.options.getString("code");

    await interaction.deferReply();

    const discordId = interaction.user.id;

    // VALIDATE CODE WITH EXPIRATION CHECK
    const validation = await validateAndCheckCode(code, "slash");
    
    if (!validation.valid) {
        return interaction.editReply(validation.error);
    }

    const codeData = validation.codeData;

    // DISCORD ALREADY LINKED?
    const { data: existingDiscord } =
        await supabase
            .from("discord_links")
            .select("*")
            .eq("discord_user_id", discordId)
            .single();

    if (existingDiscord) {
        return interaction.editReply("❌ This Discord account is already linked.");
    }

    // ROBLOX ALREADY LINKED?
    const { data: existingRoblox } =
        await supabase
            .from("discord_links")
            .select("*")
            .eq("roblox_user_id", codeData.roblox_user_id)
            .single();

    if (existingRoblox) {
        return interaction.editReply("❌ Roblox account already linked.");
    }

    // Get Roblox username
    const robloxUsername = await getRobloxUsername(codeData.roblox_user_id);

    // CREATE LINK
    const { error: linkError } =
        await supabase
            .from("discord_links")
            .insert({
                roblox_user_id: codeData.roblox_user_id,
                roblox_username: robloxUsername,
                discord_user_id: discordId,
                discord_username: interaction.user.username,
                linked_by_code: code
            });

    if (linkError) {
        return interaction.editReply("❌ Link failed.");
    }

    // MARK CODE USED
    await supabase
        .from("link_codes")
        .update({
            status: "USED",
            used_by_discord_id: discordId,
            used_at: new Date().toISOString()
        })
        .eq("code", code);

    // AUDIT LOG with usernames
    await supabase
        .from("audit_logs")
        .insert({
            event_type: "LINK_SUCCESS",
            roblox_user_id: codeData.roblox_user_id,
            roblox_username: robloxUsername,
            discord_user_id: discordId,
            discord_username: interaction.user.username,
            code: code
        });

    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle("✅ Account Linked Successfully")
        .setDescription(`**Roblox:** ${robloxUsername}\n**Discord:** ${interaction.user.username}`)
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

if (interaction.commandName === "unlink") {

    const discordId = interaction.user.id;

    const { data: linkData } =
        await supabase
            .from("discord_links")
            .select("*")
            .eq("discord_user_id", discordId)
            .single();

    if (!linkData) {
        return interaction.reply({
            content: "❌ No linked account found.",
            ephemeral: true
        });
    }

    const customId = `unlink_yes_${discordId}`;

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(customId)
                .setLabel("YES UNLINK")
                .setStyle(ButtonStyle.Danger),

            new ButtonBuilder()
                .setCustomId(`unlink_no_${discordId}`)
                .setLabel("CANCEL")
                .setStyle(ButtonStyle.Secondary)
        );

    const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle("⚠️ Confirm Unlink")
        .setDescription(`**Discord:** ${interaction.user.username}\n**Roblox:** ${linkData.roblox_username || "Unknown"}`)
        .addFields({ name: "Roblox ID", value: linkData.roblox_user_id, inline: true })
        .setFooter({ text: "This request will expire in 60 seconds" })
        .setTimestamp();

    await interaction.reply({
        embeds: [embed],
        components: [row]
    });

    // 60-second timeout
    setTimeout(async () => {
        try {
            const message = await interaction.fetchReply();
            if (message && message.components.length > 0) {
                const expiredEmbed = new EmbedBuilder()
                    .setColor(0xFFA500)
                    .setTitle("⏰ Request Expired")
                    .setDescription("No changes were made.")
                    .setTimestamp();
                
                await interaction.editReply({
                    embeds: [expiredEmbed],
                    components: []
                });
            }
        } catch (err) {
            // Message already deleted or expired
        }
    }, 60000);
}

if (interaction.commandName === "collection") {

    try {

        await interaction.deferReply();

        const discordId = interaction.user.id;

        const { data: linkData, error: linkError } =
            await supabase
                .from("discord_links")
                .select("*")
                .eq("discord_user_id", discordId)
                .single();

        if (linkError || !linkData) {

            return interaction.editReply("❌ Discord account not linked.");
        }

        const robloxId = linkData.roblox_user_id;

        const { data, error } =
            await supabase
                .from("creatures")
                .select("*")
                .eq("userid", String(robloxId));

        if (error) {

            return interaction.editReply("Database error: " + error.message);
        }

        if (!data || data.length === 0) {

            const emptyEmbed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle("📦 Collection")
                .setDescription("Your collection is empty.")
                .setFooter({ text: `${linkData.roblox_username || "Unknown"}'s Creatures` })
                .setTimestamp();

            return interaction.editReply({ embeds: [emptyEmbed] });
        }

        // Store for pagination with user-specific IDs
        const prevButtonId = `collection_prev_${discordId}`;
        const nextButtonId = `collection_next_${discordId}`;
        
        userPages.set(discordId, {
            creatures: data,
            total: data.length,
            page: 0,
            prevButtonId,
            nextButtonId
        });
        
        // Auto-cleanup after 5 minutes
        cleanupUserPages(discordId);

        const page = 0;
        const itemsPerPage = 10;
        const start = page * itemsPerPage;
        const end = start + itemsPerPage;
        const pageData = data.slice(start, end);

        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle(`📦 ${linkData.roblox_username || "Unknown"}'s Collection`)
            .setDescription(pageData.map(c => `• ${c.creaturename}`).join('\n') || "No creatures on this page")
            .setFooter({ text: `Page ${page + 1}/${Math.ceil(data.length / itemsPerPage)} • Total: ${data.length} creatures` })
            .setTimestamp();

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(prevButtonId)
                    .setLabel("◀ Previous")
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId(nextButtonId)
                    .setLabel("Next ▶")
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(data.length <= itemsPerPage)
            );

        await interaction.editReply({ embeds: [embed], components: [row] });

    } catch (err) {

        console.error(err);

        try {
            await interaction.editReply("Something went wrong.");
        } catch {}
    }
}

});

// Button handler for unlink and collection pagination
client.on("interactionCreate", async interaction => {

if (!interaction.isButton()) return;

// Handle unlink buttons
const unlinkMatch = interaction.customId.match(/unlink_(yes|no)_(\d+)/);

if (unlinkMatch) {
    const action = unlinkMatch[1];
    const originalUserId = unlinkMatch[2];

    // SECURITY: Check if clicking user matches original user
    if (interaction.user.id !== originalUserId) {
        return interaction.reply({
            content: "❌ You cannot interact with this button. Only the user who requested unlink can use it.",
            ephemeral: true
        });
    }

    if (action === "no") {
        const cancelledEmbed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle("❌ Unlink Cancelled")
            .setDescription("No changes were made.")
            .setTimestamp();

        return interaction.update({
            embeds: [cancelledEmbed],
            components: []
        });
    }

    if (action === "yes") {
        const discordId = interaction.user.id;

        const { data: linkData } =
            await supabase
                .from("discord_links")
                .select("*")
                .eq("discord_user_id", discordId)
                .single();

        if (!linkData) {
            const errorEmbed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle("❌ Error")
                .setDescription("No linked account found.")
                .setTimestamp();

            return interaction.update({
                embeds: [errorEmbed],
                components: []
            });
        }

        // AUDIT LOG with usernames
        await supabase
            .from("audit_logs")
            .insert({
                event_type: "UNLINK_SUCCESS",
                roblox_user_id: linkData.roblox_user_id,
                roblox_username: linkData.roblox_username,
                discord_user_id: discordId,
                discord_username: interaction.user.username
            });

        await supabase
            .from("discord_links")
            .delete()
            .eq("discord_user_id", discordId);

        const successEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle("✅ Account Unlinked Successfully")
            .setDescription(`**Roblox:** ${linkData.roblox_username || "Unknown"}\n**Discord:** ${interaction.user.username}`)
            .setTimestamp();

        await interaction.update({
            embeds: [successEmbed],
            components: []
        });
    }
    return;
}

// Handle collection pagination with user-specific IDs
const collectionMatch = interaction.customId.match(/collection_(prev|next)_(\d+)/);

if (collectionMatch) {
    const action = collectionMatch[1];
    const originalUserId = collectionMatch[2];
    
    // SECURITY: Check if clicking user matches original user
    if (interaction.user.id !== originalUserId) {
        return interaction.reply({
            content: "❌ You cannot interact with these buttons. Only the user who requested the collection can use them.",
            ephemeral: true
        });
    }
    
    const userData = userPages.get(originalUserId);
    
    if (!userData) {
        return interaction.reply({
            content: "❌ Session expired. Please use /collection again.",
            ephemeral: true
        });
    }

    let newPage = userData.page;
    if (action === "prev") newPage--;
    if (action === "next") newPage++;

    const itemsPerPage = 10;
    const start = newPage * itemsPerPage;
    const end = start + itemsPerPage;
    const pageData = userData.creatures.slice(start, end);

    userData.page = newPage;
    userPages.set(originalUserId, userData);

    // Get Roblox username for footer
    const { data: linkData } = await supabase
        .from("discord_links")
        .select("roblox_username")
        .eq("discord_user_id", originalUserId)
        .single();

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(`📦 ${linkData?.roblox_username || "Unknown"}'s Collection`)
        .setDescription(pageData.map(c => `• ${c.creaturename}`).join('\n'))
        .setFooter({ text: `Page ${newPage + 1}/${Math.ceil(userData.creatures.length / itemsPerPage)} • Total: ${userData.creatures.length} creatures` })
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`collection_prev_${originalUserId}`)
                .setLabel("◀ Previous")
                .setStyle(ButtonStyle.Primary)
                .setDisabled(newPage === 0),
            new ButtonBuilder()
                .setCustomId(`collection_next_${originalUserId}`)
                .setLabel("Next ▶")
                .setStyle(ButtonStyle.Primary)
                .setDisabled(end >= userData.creatures.length)
        );

    await interaction.update({ embeds: [embed], components: [row] });
}

});

client.on("messageCreate", async (message) => {

if (message.author.bot) return;

if (!message.mentions.has(client.user)) return;

const content = message.content
    .replace(`<@${client.user.id}>`, "")
    .replace(`<@!${client.user.id}>`, "")
    .trim();

const lowerContent = content.toLowerCase();

// COMMAND ROUTER
if (/^connect\s+/i.test(content)) {
    
    const codeMatch = content.match(/^connect\s+(.+)$/i);
    if (!codeMatch) {
        return message.reply("❌ Invalid format.\nUse: Connect PJB-XXXXXXXX-XXXXXXXX-XXXXXXXX");
    }

    const code = codeMatch[1].trim().toUpperCase();
    const codePattern = /^PJB-[A-Z0-9]{8}-[A-Z0-9]{8}-[A-Z0-9]{8}$/;

    if (!codePattern.test(code)) {
        return message.reply("❌ Unauthorized Argument.\nUse: Connect PJB-XXXXXXXX-XXXXXXXX-XXXXXXXX");
    }

    // VALIDATE CODE WITH EXPIRATION CHECK
    const validation = await validateAndCheckCode(code, "message");
    
    if (!validation.valid) {
        return message.reply(validation.error);
    }

    const codeData = validation.codeData;

    // DISCORD ALREADY LINKED?
    const { data: existingDiscord } =
        await supabase
            .from("discord_links")
            .select("*")
            .eq("discord_user_id", message.author.id)
            .single();

    if (existingDiscord) {
        return message.reply("❌ This Discord account is already linked.");
    }

    // ROBLOX ALREADY LINKED?
    const { data: existingRoblox } =
        await supabase
            .from("discord_links")
            .select("*")
            .eq("roblox_user_id", codeData.roblox_user_id)
            .single();

    if (existingRoblox) {
        return message.reply("❌ Roblox account already linked.");
    }

    // Get Roblox username
    const robloxUsername = await getRobloxUsername(codeData.roblox_user_id);

    // CREATE LINK
    const { error: linkError } =
        await supabase
            .from("discord_links")
            .insert({
                roblox_user_id: codeData.roblox_user_id,
                roblox_username: robloxUsername,
                discord_user_id: message.author.id,
                discord_username: message.author.username,
                linked_by_code: code
            });

    if (linkError) {
        return message.reply("❌ Link failed.");
    }

    // MARK CODE USED
    await supabase
        .from("link_codes")
        .update({
            status: "USED",
            used_by_discord_id: message.author.id,
            used_at: new Date().toISOString()
        })
        .eq("code", code);

    // AUDIT LOG with usernames
    await supabase
        .from("audit_logs")
        .insert({
            event_type: "LINK_SUCCESS",
            roblox_user_id: codeData.roblox_user_id,
            roblox_username: robloxUsername,
            discord_user_id: message.author.id,
            discord_username: message.author.username,
            code: code
        });

    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle("✅ Account Linked Successfully")
        .setDescription(`**Roblox:** ${robloxUsername}\n**Discord:** ${message.author.username}`)
        .setTimestamp();

    return message.reply({ embeds: [embed] });
}

else if (/^collection$/i.test(lowerContent)) {
    
    try {
        const { data: linkData, error: linkError } =
            await supabase
                .from("discord_links")
                .select("*")
                .eq("discord_user_id", message.author.id)
                .single();

        if (linkError || !linkData) {
            return message.reply("❌ Discord account not linked.");
        }

        const robloxId = linkData.roblox_user_id;

        const { data, error } =
            await supabase
                .from("creatures")
                .select("*")
                .eq("userid", String(robloxId));

        if (error) {
            return message.reply("Database error: " + error.message);
        }

        if (!data || data.length === 0) {
            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle("📦 Collection")
                .setDescription("Your collection is empty.")
                .setFooter({ text: `${linkData.roblox_username || "Unknown"}'s Creatures` })
                .setTimestamp();

            return message.reply({ embeds: [embed] });
        }

        // For message commands, just show first 20 since we can't paginate easily
        const displayData = data.slice(0, 20);
        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle(`📦 ${linkData.roblox_username || "Unknown"}'s Collection`)
            .setDescription(displayData.map(c => `• ${c.creaturename}`).join('\n'))
            .setFooter({ text: `Showing ${Math.min(20, data.length)} of ${data.length} creatures` })
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    } catch (err) {
        console.error(err);
        return message.reply("Something went wrong.");
    }
}

else if (/^unlink$/i.test(lowerContent)) {
    
    const discordId = message.author.id;

    const { data: linkData } =
        await supabase
            .from("discord_links")
            .select("*")
            .eq("discord_user_id", discordId)
            .single();

    if (!linkData) {
        return message.reply("❌ No linked account found.");
    }

    const customId = `unlink_yes_${discordId}`;
    const noCustomId = `unlink_no_${discordId}`;

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(customId)
                .setLabel("YES UNLINK")
                .setStyle(ButtonStyle.Danger),

            new ButtonBuilder()
                .setCustomId(noCustomId)
                .setLabel("CANCEL")
                .setStyle(ButtonStyle.Secondary)
        );

    const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle("⚠️ Confirm Unlink")
        .setDescription(`**Discord:** ${message.author.username}\n**Roblox:** ${linkData.roblox_username || "Unknown"}`)
        .addFields({ name: "Roblox ID", value: linkData.roblox_user_id, inline: true })
        .setFooter({ text: "This request will expire in 60 seconds" })
        .setTimestamp();

    const reply = await message.reply({
        embeds: [embed],
        components: [row]
    });

    // 60-second timeout
    setTimeout(async () => {
        try {
            const fetchedMsg = await reply.fetch();
            if (fetchedMsg && fetchedMsg.components.length > 0) {
                const expiredEmbed = new EmbedBuilder()
                    .setColor(0xFFA500)
                    .setTitle("⏰ Request Expired")
                    .setDescription("No changes were made.")
                    .setTimestamp();
                
                await reply.edit({
                    embeds: [expiredEmbed],
                    components: []
                });
            }
        } catch (err) {
            // Message already deleted or expired
        }
    }, 60000);
}

else if (/^help$/i.test(lowerContent)) {
    
    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle("📚 ProjectB Bot Commands")
        .setDescription("Here are all the available commands:")
        .addFields(
            { name: "📝 Message Commands", value: "Use these by mentioning the bot:\n`@ProjectBBot Connect PJB-XXXX-XXXX-XXXX` - Link your Roblox account\n`@ProjectBBot Collection` - View your creature collection\n`@ProjectBBot Unlink` - Unlink your Roblox account\n`@ProjectBBot Help` - Show this message", inline: false },
            { name: "⚡ Slash Commands", value: "Use these with `/`:\n`/connect` - Link with a code\n`/collection` - View collection\n`/unlink` - Unlink account", inline: false }
        )
        .setFooter({ text: "Need help? Contact support!" })
        .setTimestamp();

    return message.reply({ embeds: [embed] });
}

else {
    const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle("❌ Unknown Command")
        .setDescription("Available commands:\n• `Connect PJB-XXXX-XXXX-XXXX`\n• `Collection`\n• `Unlink`\n• `Help`")
        .setTimestamp();

    return message.reply({ embeds: [embed] });
}

});

client.login(process.env.DISCORD_TOKEN);
