'use strict';
// Stała sesja tmux z shellem dla doku w Dyspozytorze (/ws?shell=1): jedna na serwer, poza herdr.
// Dok tylko się do niej podpina - zamknięcie doku albo rozłączenie WS nie zabija sesji.
const SHELL_SESSION = 'ccp-shell';

// tmux(args) -> Promise (jak w server.js). Zwraca nazwę sesji gotowej do attach.
async function ensureShellSession(tmux, home) {
  const has = () => tmux(['has-session', '-t', `=${SHELL_SESSION}`]).then(() => true, () => false);
  if (await has()) return SHELL_SESSION;
  try {
    await tmux(['new-session', '-d', '-s', SHELL_SESSION, '-c', home]);
  } catch (e) {
    // dwie karty naraz: druga dostaje „duplicate session” - sesja i tak już jest
    if (!(await has())) throw e;
  }
  return SHELL_SESSION;
}

module.exports = { SHELL_SESSION, ensureShellSession };
