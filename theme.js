// Colours, taken from ~/.bash_profile (MY_PURPLE, MY_ORANGE, MY_RED) as 256-colour codes.
// Change the numbers here to restyle the whole app.
export const PURPLE = 60;  // prompt, chat numbers, open-chat highlight
export const ORANGE = 139; // chat names on messages from other chats, "more below" marker, warnings
export const RED = 161;    // "me"

// Bold + 256-colour foreground, like the PS1 definitions.
export const sgr = (n) => `\x1b[1;38;5;${n}m`;
