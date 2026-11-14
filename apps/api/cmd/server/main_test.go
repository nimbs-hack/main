package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestStaticAndAPIRouting(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{"index.html": "<html>Mars</html>", "app.js": "const mars = true"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	app, flush := handler(t.TempDir(), dir, t.TempDir(), http.DefaultClient)
	defer flush()
	for _, test := range []struct {
		method, path string
		status       int
		body         string
	}{
		{"GET", "/", 200, "<html>Mars</html>"},
		{"GET", "/landing/curiosity", 200, "<html>Mars</html>"},
		{"GET", "/app.js", 200, "const mars = true"},
		{"HEAD", "/app.js", 200, ""},
		{"GET", "/api/unknown", 404, "404 page not found\n"},
		{"GET", "/api", 404, "404 page not found\n"},
		{"POST", "/api/unknown", 404, "404 page not found\n"},
		{"GET", "/api/imagery/ctx-v01/13/0/0.png", 400, ""},
		{"GET", "/api/terrain/mars-v14/19/0/0.terrain", 400, ""},
	} {
		t.Run(test.method+test.path, func(t *testing.T) {
			res := httptest.NewRecorder()
			app.ServeHTTP(res, httptest.NewRequest(test.method, test.path, nil))
			if res.Code != test.status {
				t.Fatalf("status = %d, want %d", res.Code, test.status)
			}
			if test.body != "" && res.Body.String() != test.body {
				t.Fatalf("body = %q, want %q", res.Body.String(), test.body)
			}
		})
	}
}
