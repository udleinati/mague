FROM postgres:18.3-alpine

RUN apk add --no-cache build-base git perl perl-app-cpanminus \
 && cpanm --quiet --notest TAP::Parser::SourceHandler::pgTAP \
 && apk del build-base git

ENTRYPOINT ["pg_prove"]
