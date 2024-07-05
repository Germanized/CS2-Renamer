import * as path from 'path';
import SteamUser from 'steam-user';
import inquirer from 'inquirer';
import ProtobufJS from 'protobufjs';
import * as fs from 'fs';
import fetch from 'node-fetch';
import * as VDF from 'vdf-parser';
import { Items, defaultItems, english } from './helpers/Items.js';

const steam = new SteamUser();
const protobufs = new ProtobufJS.Root().loadSync([
    path.join(process.cwd(), 'protobufs', 'cs2', 'base_gcmessages.proto'),
    path.join(process.cwd(), 'protobufs', 'cs2', 'gcsystemmsgs.proto'),
    path.join(process.cwd(), 'protobufs', 'cs2', 'gcsdk_gcmessages.proto'),
    path.join(process.cwd(), 'protobufs', 'cs2', 'econ_gcmessages.proto')
], {
    keepCase: true
});
const items = new Items();
const INVENTORY_LINK_REGEX = /730_2_(?<itemID>\d+)/i;
let loginPersonaCheck = false;
let gcConnectInterval = null;
let gcFirstConnect = true;
let gcListeners = {
    add: function (msgPath, type, callback, once = false) {
        let parts = msgPath.split('.');
        let msgType = protobufs.lookupEnum(parts[0]).values[parts[1]];
        if (!msgType) {
            throw new Error(`Could not find message type for "${parts[0]}.${parts[1]}"`);
        }

        let decoder = protobufs.lookupType(type);
        if (!gcListeners[msgType]) {
            gcListeners[msgType] = [];
        }

        gcListeners[msgType].push({
            decoderName: type,
            decoder: decoder,
            callback: callback,
            once: once
        });
    }
};

let { username, password } = await inquirer.prompt([
    {
        type: 'input',
        name: 'username',
        message: 'Welcome to CS2 nametag tool by Pronhubstar Now Enter your Steam account username',
        when: process.argv.length <= 2
    },
    {
        type: 'password',
        name: 'password',
        message: 'Enter your Steam account password',
        when: process.argv.length <= 3
    }
]);
if (!username && process.argv.length > 2) {
    username = process.argv[2];
} else if (!username) {
    throw new Error('You did not enter a valid username');
}

if (!password && process.argv.length > 3) {
    password = process.argv[3];
} else if (!password) {
    throw new Error('You did not enter a valid password');
}

async function sendGCHello() {
    const text = await fetch('https://raw.githubusercontent.com/SteamDatabase/GameTracking-CS2/master/game/csgo/steam.inf').then(r => r.text());
    const lines = text.split('\n').map(l => l.replace(/\r/g, '').trim());
    const idx = lines.findIndex(l => l.startsWith('ClientVersion='));
    let version = undefined;
    if (idx >= 0) {
        const versionStr = lines[idx].split('=').pop();
        version = parseInt(versionStr);
        if (isNaN(version)) {
            console.log('Warning: Failed to parse required client version from steam.inf');
            version = undefined;
        }
    }
    sendGCMessage('EGCBaseClientMsg.k_EMsgGCClientHello', 'CMsgClientHello', {}, {
        version: version
    });
}

console.log('Logging into Steam...');
steam.logOn({
    accountName: username,
    password: password
});

steam.on('loggedOn', async () => {
    console.log(`Logged into Steam as ${steam.steamID.getSteamID64()}`);
    console.log('Waiting for user information...');
    loginPersonaCheck = false;
    steam.setPersona(SteamUser.EPersonaState.Online);
});

steam.on('user', (sid, user) => {
    if (sid.accountid !== steam.steamID.accountid) {
        return;
    }

    if (loginPersonaCheck) {
        return;
    }
    loginPersonaCheck = true;

    if (user.gameid !== '0') {
        console.log('Someone is already playing on this account. You must close all games and stop all idlers.');
        steam.logOff();
        return;
    }

    console.log('Connecting to CS2 backend...');

    steam.gamesPlayed([730]);
    clearInterval(gcConnectInterval);
    gcConnectInterval = setInterval(sendGCHello, 1000).unref();
});

steam.on('playingState', (blocked, playingApp) => {
    if (blocked) {
        console.log('Someone started playing on this account. Logging off...');
        steam.logOff();
    }
});

steam.on('steamGuard', async (domain, callback, lastCodeWrong) => {
    let { code } = await inquirer.prompt([
        {
            type: 'input',
            name: 'code',
            message: `Steam Guard required${lastCodeWrong ? ' (Last code wrong)' : ''}`
        }
    ]);

    console.log('Logging into Steam...');
    callback(code);
});

steam.on('receivedFromGC', (appID, msgType, payload) => {
    if (appID !== 730 || !gcListeners[msgType]) {
        return;
    }

    let cache = {};
    for (let i = gcListeners[msgType].length - 1; i >= 0; i--) {
        let listener = gcListeners[msgType][i];
        let obj = cache[listener.decoderName] ?? listener.decoder.toObject(listener.decoder.decode(payload));
        cache[listener.decoderName] = obj;

        if (listener.once) {
            gcListeners[msgType].splice(i, 1);
        }
        listener.callback(obj);
    }
});

steam.on('error', (err) => {
    console.log('An unrecoverable error has occurred: ', err.toString());
    steam.logOff();
    process.exit(1);
});

steam.on('disconnected', (eResult, msg) => {
    console.log(`Disconnected from Steam with code: ${eResult}${msg && msg.length > 0 ? ` / ${msg}` : ''}`);
    process.exit(1);
});

function decodeProtobuf(type, data) {
    let decoder = protobufs.lookupType(type);
    return decoder.toObject(decoder.decode(data));
}

function sendGCMessage(msgPath, type, header, data, callback = undefined) {
    let parts = msgPath.split('.');
    let msgType = protobufs.lookupEnum(parts[0]).values[parts[1]];
    if (!msgType) {
        throw new Error(`Could not find message type for "${parts[0]}.${parts[1]}"`);
    }

    let encoder = typeof type === 'string' ? protobufs.lookupType(type) : undefined;
    steam.sendToGC(730, msgType, header, encoder ? encoder.encode(data).finish() : data, callback);
}

gcListeners.add('EGCBaseClientMsg.k_EMsgGCClientWelcome', 'CMsgClientWelcome', async (data) => {
    if (!gcConnectInterval) {
        return;
    }
    clearInterval(gcConnectInterval);
    gcConnectInterval = null;

    if (gcFirstConnect) {
        console.log(`Connected to CS2 backend, server time: ${new Date(data.rtime32_gc_welcome_timestamp * 1000).toLocaleString()}`);
        gcFirstConnect = false;
    }

    items._items = data.outofdate_subscribed_caches.map((cache) => {
        cache.objects = cache.objects.filter((object) => {
            return object.type_id === 1;
        }).map((object) => {
            return object.object_data.map((data) => {
                return decodeProtobuf('CSOEconItem', data);
            });
        });
        return cache;
    }).reduce((prev, cur) => {
        for (let object of cur.objects) {
            prev.push(...object);
        }
        return prev;
    }, []);
    console.log(`We have ${items._items.length} item${items._items.length === 1 ? '' : 's'}`);
    if (items._items.length <= 0) {
        console.log('You do not have any items, buy a name tag first');
        steam.logOff();
        return;
    }

    let nameTags = items._items.filter(i => i.def_index === 1200);
    let storageUnits = items._items.filter(i => i.def_index === 1201);
    console.log(`We have ${nameTags.length} name tag${nameTags.length === 1 ? '' : 's'}`);
    console.log(`We have ${storageUnits.length} storage unit${storageUnits.length === 1 ? '' : 's'}`);
    if (nameTags.length <= 0 && storageUnits.length <= 0) {
        console.log('You have no name tags or storage units, buy some first');
        steam.logOff();
        return;
    }

    getUserRenameInput(nameTags.length > 0);
});

async function getUserRenameInput(haveNameTags) {
    let itemSelection = await inquirer.prompt([
        {
            type: 'list',
            name: 'type',
            message: 'Do you want to rename a default item or a normal item?',
            choices: [
                {
                    name: 'Default Item',
                    value: 'default',
                    disabled: !haveNameTags
                },
                {
                    name: 'Normal Item',
                    value: 'normal'
                },
                {
                    name: 'Log out and exit program',
                    value: 'quit'
                }
            ]
        },
        {
            type: 'input',
            name: 'name',
            message: 'Enter the new name for the item',
            when: (answers) => answers.type !== 'quit',
            validate: (answer) => {
                if (answer.length < 1) {
                    return 'The name must be at least 1 character long';
                }
                if (answer.length > 40) {
                    return 'The name must be no longer than 40 characters';
                }
                return true;
            }
        }
    ]);

    if (itemSelection.type === 'quit') {
        console.log('Goodbye!');
        steam.logOff();
        return;
    }

    let itemChoices = [];
    if (itemSelection.type === 'default') {
        for (let nameTag of items._items.filter(i => i.def_index === 1200)) {
            itemChoices.push({
                name: `Name Tag (Item ID ${nameTag.id})`,
                value: nameTag
            });
        }
    } else {
        for (let storageUnit of items._items.filter(i => i.def_index === 1201)) {
            itemChoices.push({
                name: `Storage Unit (Item ID ${storageUnit.id})`,
                value: storageUnit
            });
        }
    }

    if (itemChoices.length <= 0) {
        console.log('You do not have any items that can be renamed');
        steam.logOff();
        return;
    }

    let itemChoice = await inquirer.prompt([
        {
            type: 'list',
            name: 'item',
            message: 'Choose the item you want to rename',
            choices: itemChoices
        }
    ]);

    let item = itemChoice.item;

    sendGCMessage('EGCItemCustomization.k_EMsgGCNameItem', 'CMsgNameItem', {
        item_id: item.id,
        name: itemSelection.name
    });

    console.log(`Item renaming initiated for item ID ${item.id} to name "${itemSelection.name}"`);
}
