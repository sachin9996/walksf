.PHONY: all

CSS_HASH := $(shell shasum -a 256 static/index.css | cut -c1-12)
NOSCRIPT_CSS_HASH := $(shell shasum -a 256 static/noscript.css | cut -c1-12)
JS_HASH := $(shell shasum -a 256 static/index.js | cut -c1-12)

# BSD sed (macOS) wants `sed -i ''`; GNU sed (Linux) wants `sed -i`.
ifeq ($(shell uname),Darwin)
SED_I := sed -i ''
else
SED_I := sed -i
endif

all:
	$(SED_I) -E \
		-e 's#index\.[^./]+\.css#index.$(CSS_HASH).css#g' \
		-e 's#noscript\.[^./]+\.css#noscript.$(NOSCRIPT_CSS_HASH).css#g' \
		-e 's#index\.[^./]+\.js#index.$(JS_HASH).js#g' \
		static/index.html main.go
	go build -o walksf .
