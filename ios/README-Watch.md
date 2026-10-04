# Bottega per Apple Watch

`cd ios && xcodegen generate` crea i target `BottegaWatch` e `BottegaWatchWidget`.
Il minimo e' watchOS 26. La build usa l'SDK installato in Xcode e incorpora l'app Watch
in `Bottega.app/PlugIns`, come richiesto da Xcode 26 e successivi.

L'iPhone resta l'unico client del Mac: mantiene il ponte HTTPS, il certificato e il
gettone. `OrologioTelefono` prende lo stato gia' decodificato, ne produce una
`IstantaneaOrologio` e la manda con `WCSession.updateApplicationContext`. Il payload
contiene i contatori, lo stato di Melissa e fino a 12 sessioni ordinate per priorita'.
Non contiene chiavi o token. A contenuto invariato si invia al massimo un aggiornamento
ogni dieci minuti, cosi' il Watch mostra l'eta' reale dello stato senza ricevere ogni
evento del flusso. Il pulsante sull'orologio chiede una lettura all'iPhone quando questo
e' raggiungibile. Con l'iPhone lontano l'ultima copia resta visibile con la sua eta'.

L'app Watch e la complicazione condividono una copia con App Groups sul Watch. Quando
l'iPhone si scollega o cambia Mac, manda una cancellazione. `BottegaWatchWidget`
fornisce complicazioni circolare, rettangolare, in linea e ad angolo; WidgetKit
decide quando aggiornare il quadrante. Il display Always On non esiste su Apple Watch
SE: l'app non usa animazioni continue, sensori o polling in background.

Verifiche CLI:

```sh
cd ios
xcodegen generate
xcodebuild -project Bottega.xcodeproj -scheme BottegaWatch \
  -destination 'generic/platform=watchOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project Bottega.xcodeproj -scheme Bottega \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project Bottega.xcodeproj -scheme Bottega -configuration Release \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates build
```

La consegna su due dispositivi abbinati va verificata su iPhone e Apple Watch reali:
il simulatore conferma avvio e layout, ma non riproduce tutte le condizioni di
WatchConnectivity in background.
