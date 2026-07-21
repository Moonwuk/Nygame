// ruleid: no-innerhtml-assignment
el.innerHTML = '<b>' + userInput + '</b>';

// ok: no-innerhtml-assignment
el.textContent = userInput;
