# Agnes nel terminale della Bottega. All'Invio il widget guarda la riga: se e' un comando la esegue come sempre; se e'
# una frase in italiano la manda all'estensione sul socket locale (~/.bottega/terminale.sock, con zsh/net/socket:
# niente curl, nessuna chiave nella shell) e propone il comando. Cosa succede poi lo decide l'estensione con
# bottega.terminale.agnesModo: nel buffer da confermare (proponi), con la domanda «eseguo?» (chiedi), oppure subito se
# consentito o innocuo (auto). I paletti (cancellazioni, push, pubblicazioni, sudo, scritture fuori) chiedono sempre.
# Forzare: «# richiesta», «? richiesta», «#! deepseek richiesta», «#! agnes richiesta»; «??» spiega l'ultimo errore.
# Caricato da .zshrc di ~/.bottega/zsh dopo quello vero di Andrea. Copiato dall'estensione da
# extensions/bottega-home/shell: si modifica li'. Contratto: docs/CONTRATTI.md, sezione 12.

(( ${+functions[__bottega_naturale]} )) && return 0

typeset -g __bottega_zdot=${${(%):-%x}:A:h}
typeset -g __bottega_sock=${BOTTEGA_TERMINALE_SOCK:-${__bottega_zdot:h}/terminale.sock}
typeset -ga __bottega_funzione=(
	mi ti ci si il lo la i gli le un una uno di del dello della dei degli delle che per con tutti tutte tutto questo
	questa questi queste quelli quelle quello quella dove quali quale come fammi dammi dimmi mostrami trovami cercami
	nel nella nei negli nelle dal dalla dai al alla ai sono cosa qui qua quanto quanta quanti quante piu più non ultimo
	ultima ultimi ultime oggi ieri dentro mio mia miei mie
)
typeset -gA __bottega_noti

# ---------- il riconoscimento: comando o frase? (tutto nella shell, sotto il millisecondo) ----------

# La prima parola e' un comando (alias, funzione, builtin, parola riservata, programma nel PATH, cartella con autocd)?
# Il risultato resta in memoria fino al prossimo prompt.
__bottega_conosciuto() {
	local v=${__bottega_noti[$1]}
	if [[ -z $v ]]; then
		if whence -- "$1" >/dev/null 2>&1 || [[ -o autocd && -d $1 ]]; then v=1; else v=0; fi
		__bottega_noti[$1]=$v
	fi
	(( v ))
}

# 0 se la riga e' una frase da chiedere, 1 se e' un comando da eseguire.
__bottega_naturale() {
	emulate -L zsh
	setopt extendedglob
	local riga=${${1##[[:space:]]##}%%[[:space:]]##}
	# vuota, su piu' righe, o continuazione: comando
	[[ -z $riga || $riga == *$'\n'* || $riga == *\\ ]] && return 1
	local -a parole=(${=riga})
	local -i i=1
	# assegnazioni iniziali e prefissi: conta la parola dopo
	while (( i <= $#parole )) && [[ $parole[i] == [[:alpha:]_][[:alnum:]_]#=* || $parole[i] == (noglob|command|builtin|nocorrect|exec|-) ]]; do
		(( i++ ))
	done
	(( i > $#parole )) && return 1
	# x=(uno due): un'assegnazione di un array
	(( i > 1 )) && [[ ${(j: :)parole[1,i-1]} == *\(* ]] && return 1
	local prima=$parole[i]
	local -a resto=(${parole[i+1,-1]})
	# un percorso, o sintassi di shell nella prima parola (funzione(), x=, {, [): comando
	[[ $prima == (/|./|../|\~)* || $prima == *[\(\)\{\}\[\]=\$\"\`\<\>\|\;\&]* ]] && return 1
	# una domanda di almeno tre parole che finisce con il punto di domanda
	(( $#resto >= 2 )) && [[ $riga == *[[:alpha:]]\? ]] && return 0
	if ! __bottega_conosciuto $prima; then
		# la prima parola non e' un comando: frase, se ha almeno due parole e niente pipe, redirezioni, ; o $( )
		(( $#resto )) || return 1
		[[ $riga == *([\|\;\<\>\`]|'$('|'&&')* ]] && return 1
		return 0
	fi
	# prima parola valida seguita da italiano: «git mi fai un commit con tutto», «ls tutti i file modificati oggi»
	[[ $prima == (echo|print|printf|say|for|while|until|if|case|select|function|repeat|time|'[['|'['|'(('|'{'|'}'|'!') ]] && return 1
	local p
	local -i fun=0
	for p in $resto; do
		# flag, percorsi, variabili, redirezioni, virgolette di un argomento, glob: comando
		[[ $p == -* || $p == *[/\$\"\`\;\|\<\>\&\*\(\)\{\}\[\]=~]* || $p == \'* ]] && return 1
		(( ${__bottega_funzione[(Ie)$p]} )) && (( fun++ ))
	done
	(( fun >= 2 || (fun >= 1 && $#resto >= 3) )) && return 0
	return 1
}

# Per i test del classificatore: solo le funzioni sopra.
[[ -n $BOTTEGA_SOLO_RICONOSCIMENTO ]] && return 0
[[ -o interactive ]] || return 0
zmodload zsh/net/socket 2>/dev/null || return 0
zmodload -F zsh/datetime p:EPOCHREALTIME 2>/dev/null
autoload -Uz add-zle-hook-widget add-zsh-hook is-at-least
is-at-least 5.3 || return 0

typeset -g __bottega_ultimo='' __bottega_nome=Agnes __bottega_riga='' __bottega_proposta='' __bottega_origine=''
typeset -g __bottega_mappa=main __bottega_attesa='' __bottega_post='' __bottega_indizio_riga=$'\0' __bottega_consentibile=no
typeset -gi __bottega_codice=0 __bottega_vivo=0 __bottega_spento=0 __bottega_forza=0 __bottega_cosi=0
typeset -gF __bottega_t0=0

# ---------- prima e dopo ogni comando ----------

__bottega_precmd() {
	local -i s=$?
	__bottega_codice=$s
	__bottega_cosi=0
	__bottega_noti=()
	[[ -S $__bottega_sock ]] && __bottega_vivo=1 || __bottega_vivo=0
	if [[ -r $__bottega_zdot/cervello ]]; then
		local n
		read -r n < $__bottega_zdot/cervello
		[[ -n $n ]] && __bottega_nome=$n
	fi
	# una frase finita in command_not_found_handler: la si chiede al prossimo prompt
	local f=$__bottega_zdot/.richiesta.$$
	if [[ -f $f ]]; then
		__bottega_attesa=$(<$f)
		zf_rm -f -- $f 2>/dev/null || command rm -f -- $f
	fi
	return $s
}
__bottega_preexec() { __bottega_ultimo=$1 }
zmodload -F zsh/files b:zf_rm 2>/dev/null
# il primo dei precmd: deve leggere il codice d'uscita prima degli altri (lo restituisce, per VS Code e il prompt)
precmd_functions=(__bottega_precmd ${precmd_functions:#__bottega_precmd})
add-zsh-hook preexec __bottega_preexec

# ---------- il socket ----------

# __bottega_chiedi chiave valore ...: una richiesta all'estensione. Le righe della risposta finiscono in $reply.
__bottega_chiedi() {
	emulate -L zsh
	local -i fd
	zsocket $__bottega_sock 2>/dev/null || return 1
	fd=$REPLY
	while (( $# >= 2 )); do
		print -r -u $fd -- "$1 ${${2//$'\n'/$'\x1e'}//$'\r'/}"
		shift 2
	done
	print -u $fd ''
	reply=()
	local riga=''
	while IFS= read -r -u $fd -t 60 riga || [[ -n $riga ]]; do
		reply+=("$riga")
		riga=''
	done
	exec {fd}>&-
	(( $#reply ))
}

__bottega_grigio() { print -r -- $'\e[90m'"$*"$'\e[0m' }
__bottega_ambra() { print -r -- $'\e[33m'"$*"$'\e[0m' }

# ---------- l'indizio mentre si scrive: «Agnes» in grigio dopo la riga ----------

__bottega_togli_indizio() {
	region_highlight=(${region_highlight:#*memo=bottega*})
	if [[ -n $__bottega_post && $POSTDISPLAY == $__bottega_post ]]; then POSTDISPLAY=''; fi
	__bottega_post=''
}

__bottega_indizio() {
	emulate -L zsh
	(( __bottega_spento )) && return
	[[ $BUFFER == $__bottega_indizio_riga ]] && return
	__bottega_indizio_riga=$BUFFER
	local -i si=0
	if (( __bottega_vivo )) && [[ $KEYMAP != bottega_domanda ]]; then
		if [[ $BUFFER == ('# '|'? '|'??'|'#!')* ]] || __bottega_naturale "$BUFFER"; then si=1; fi
	fi
	if (( si )); then
		[[ -z $POSTDISPLAY || $POSTDISPLAY == $__bottega_post ]] || return
		region_highlight=(${region_highlight:#*memo=bottega*})
		__bottega_post="   $__bottega_nome"
		POSTDISPLAY=$__bottega_post
		region_highlight+=("$#BUFFER $(( $#BUFFER + $#POSTDISPLAY )) fg=8,memo=bottega")
	else
		__bottega_togli_indizio
	fi
}

__bottega_inizio() {
	__bottega_spento=0
	__bottega_indizio_riga=$'\0'
	__bottega_post=''
	# una frase arrivata da command_not_found_handler
	if [[ -n $__bottega_attesa ]]; then
		BUFFER=$__bottega_attesa
		__bottega_attesa=''
		__bottega_forza=1
		zle __bottega_accetta
	fi
}

# ---------- l'Invio ----------

__bottega_accetta() {
	emulate -L zsh
	__bottega_spento=1
	__bottega_togli_indizio
	local riga=$BUFFER tipo='' cervello='' richiesta='' origine=forzata
	if (( __bottega_forza )); then
		__bottega_forza=0
		tipo=comando richiesta=$riga
	elif [[ $riga != *$'\n'* ]]; then
		if [[ $riga =~ '^#![[:space:]]*(agnes|deepseek)[[:space:]]+(.+)$' ]]; then
			tipo=comando cervello=$match[1] richiesta=$match[2]
		elif [[ $riga =~ '^[[:space:]]*\?\?([[:space:]]+(.*))?$' ]]; then
			tipo=perche richiesta=$match[2]
		elif [[ $riga =~ '^[[:space:]]*[#?][[:space:]]+(.+)$' ]]; then
			tipo=comando richiesta=$match[1]
		elif (( __bottega_vivo )) && [[ -S $__bottega_sock ]] && __bottega_naturale "$riga"; then
			tipo=comando richiesta=$riga origine=auto
		fi
	fi
	if [[ -z $tipo ]]; then
		zle __bottega_accetta_prima
		return
	fi
	if [[ ! -S $__bottega_sock ]]; then
		zle -I
		__bottega_grigio "la Bottega e' chiusa: $__bottega_nome risponde solo con la Bottega aperta"
		return
	fi
	__bottega_t0=$EPOCHREALTIME
	local nome=$__bottega_nome
	[[ $cervello == agnes ]] && nome=Agnes
	[[ $cervello == deepseek ]] && nome=DeepSeek
	zle -I
	print -rn -- $'\e[90m'"$nome pensa…"$'\e[0m'
	local -a reply
	__bottega_chiedi azione proponi tipo $tipo origine $origine cervello "$cervello" cartella "$PWD" \
		zsh "$ZSH_VERSION" ultimo "$__bottega_ultimo" codice "$__bottega_codice" richiesta "$richiesta"
	local -i ok=$(( ! $? ))
	print -rn -- $'\r\e[2K'
	# Invio doppio mentre pensava: la riga era un comando, la si esegue cosi' com'e'
	if [[ $origine == auto ]] && (( PENDING )); then
		zle read-command
		if [[ $KEYS == ($'\r'|$'\n') ]]; then
			__bottega_grigio "doppio invio: eseguo la riga com'era"
			__bottega_cosi=1
			BUFFER=$riga
			zle __bottega_accetta_prima
			return
		fi
		zle -U -- "$KEYS"
	fi
	local esegui=proponi consentibile=no errore='' comando='' r
	local -a avvisi note spiega risposta
	local -i corpo=0
	for r in "${reply[@]}"; do
		if (( corpo )); then comando+=${comando:+$'\n'}$r; continue; fi
		case $r in
			'') corpo=1 ;;
			'esegui '*) esegui=${r#esegui } ;;
			'consentibile '*) consentibile=${r#consentibile } ;;
			'avviso '*) avvisi+=("${r#avviso }") ;;
			'nota '*) note+=("${r#nota }") ;;
			'spiega '*) spiega+=("${r#spiega }") ;;
			'risposta '*) risposta+=("${r#risposta }") ;;
			'errore '*) errore=${r#errore } ;;
		esac
	done
	(( ok )) || errore="la Bottega non risponde sul terminale"
	print -s -- "$riga"
	for r in $note; do __bottega_grigio "$r"; done
	for r in $spiega; do print -r -- "$r"; done
	# una domanda: ha risposto Melissa, la riga si svuota
	if (( $#risposta )) && [[ -z $errore ]]; then
		for r in $risposta; do print -r -- "$r"; done
		BUFFER=''
		CURSOR=0
		return
	fi
	if [[ -n $errore || -z $comando ]]; then
		[[ -n $errore ]] && __bottega_grigio "$errore"
		BUFFER=$riga
		CURSOR=$#BUFFER
		return
	fi
	for r in $avvisi; do __bottega_ambra "attenzione: $r"; done
	case $esegui in
		subito)
			__bottega_grigio "eseguo, e' tra i consentiti"
			BUFFER=$comando
			zle __bottega_accetta_prima
			;;
		chiedi)
			__bottega_riga=$riga
			__bottega_proposta=$comando
			__bottega_origine=$origine
			__bottega_consentibile=$consentibile
			local domanda="eseguo? [invio] sì, "
			[[ $consentibile == si ]] && domanda+="[s]empre, "
			domanda+="[n]o, [m]odifica"
			[[ $origine == auto ]] && domanda+=", [esc] la tua riga com'era"
			if (( $#avvisi )); then __bottega_ambra "$domanda"; else __bottega_grigio "$domanda"; fi
			BUFFER=$comando
			CURSOR=$#BUFFER
			__bottega_mappa=${KEYMAP:-main}
			[[ $__bottega_mappa == (bottega_domanda|vicmd|isearch|command|.safe) ]] && __bottega_mappa=main
			zle -K bottega_domanda
			;;
		*)
			BUFFER=$comando
			CURSOR=$#BUFFER
			;;
	esac
}

# ---------- la domanda «eseguo?»: una mappa di tasti sua ----------

__bottega_esci_domanda() { zle -K $__bottega_mappa }

__bottega_si() {
	emulate -L zsh
	__bottega_esci_domanda
	# il secondo Invio di un doppio Invio veloce: la riga era un comando
	if [[ $__bottega_origine == auto ]] && (( EPOCHREALTIME - __bottega_t0 < 1.0 )); then
		__bottega_cosi=1
		BUFFER=$__bottega_riga
	else
		BUFFER=$__bottega_proposta
	fi
	zle __bottega_accetta_prima
}

__bottega_sempre() {
	emulate -L zsh
	if [[ $__bottega_consentibile != si ]]; then
		zle -M "questo comando chiede sempre: invio sì, n no, m modifica"
		return
	fi
	__bottega_esci_domanda
	zle -I
	local -a reply
	local r
	__bottega_chiedi azione consenti cartella "$PWD" comando "$__bottega_proposta"
	for r in "${reply[@]}"; do
		case $r in
			'nota '*) __bottega_grigio "${r#nota }" ;;
			'errore '*) __bottega_ambra "${r#errore }" ;;
		esac
	done
	BUFFER=$__bottega_proposta
	zle __bottega_accetta_prima
}

__bottega_no() {
	__bottega_esci_domanda
	BUFFER=''
	zle -M 'annullato'
}

__bottega_modifica() {
	__bottega_esci_domanda
	BUFFER=$__bottega_proposta
	CURSOR=$#BUFFER
}

__bottega_mia() {
	emulate -L zsh
	__bottega_esci_domanda
	if [[ $__bottega_origine != auto ]]; then
		BUFFER=''
		zle -M 'annullato'
		return
	fi
	__bottega_cosi=1
	BUFFER=$__bottega_riga
	zle __bottega_accetta_prima
}

__bottega_aspetta() { zle -M "invio sì, n no, m modifica" }

# ---------- quando zsh non trova il comando ----------

(( ${+functions[command_not_found_handler]} )) && functions -c command_not_found_handler __bottega_cnf_prima
command_not_found_handler() {
	emulate -L zsh
	local riga=${__bottega_ultimo#"${__bottega_ultimo%%[![:space:]]*}"}
	# una frase di almeno due parole, scritta da sola sulla riga e senza sintassi di shell: la si chiede ad Agnes
	if (( ! __bottega_cosi && $# >= 2 )) && [[ -S $__bottega_sock && $riga == "$1"* && $riga != *[\|\;\&\<\>\`\$\(\)\{\}]* ]]; then
		print -r -- "$riga" >| $__bottega_zdot/.richiesta.$$
		print -r -- $'\e[90m'"$1 non e' un comando: lo chiedo a $__bottega_nome"$'\e[0m' >&2
		return 0
	fi
	if (( ${+functions[__bottega_cnf_prima]} )); then
		__bottega_cnf_prima "$@"
		return
	fi
	print -ru2 -- "zsh: command not found: $1"
	return 127
}

# ---------- i widget ----------

zle -A accept-line __bottega_accetta_prima
zle -N accept-line __bottega_accetta
zle -N __bottega_accetta
zle -N __bottega_si
zle -N __bottega_sempre
zle -N __bottega_no
zle -N __bottega_modifica
zle -N __bottega_mia
zle -N __bottega_aspetta
zle -N __bottega_indizio
zle -N __bottega_inizio
add-zle-hook-widget line-pre-redraw __bottega_indizio
add-zle-hook-widget line-init __bottega_inizio

bindkey -N bottega_domanda
bindkey -M bottega_domanda '^M' __bottega_si '^J' __bottega_si
bindkey -M bottega_domanda s __bottega_sempre S __bottega_sempre
bindkey -M bottega_domanda n __bottega_no N __bottega_no
bindkey -M bottega_domanda m __bottega_modifica M __bottega_modifica
bindkey -M bottega_domanda '^[' __bottega_mia
# le frecce cominciano con Esc: legate a niente, cosi' Esc da solo resta Esc
() {
	local k
	for k in '^[[A' '^[[B' '^[[C' '^[[D' '^[OA' '^[OB' '^[OC' '^[OD'; do
		bindkey -M bottega_domanda $k __bottega_aspetta
	done
}
