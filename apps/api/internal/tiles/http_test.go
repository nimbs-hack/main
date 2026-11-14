package tiles

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchBoundsBody(t *testing.T) {
	for _, chunked := range []bool{false, true} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if chunked {
				w.(http.Flusher).Flush()
			}
			_, _ = w.Write([]byte("12345"))
		}))
		_, _, err := Fetch(context.Background(), server.Client(), server.URL, 4)
		server.Close()
		if err == nil {
			t.Fatalf("accepted oversize body, chunked=%v", chunked)
		}
	}
}

func TestParseCoordinate(t *testing.T) {
	for _, s := range []string{"", "-1", "+1", "01", "1.0", " 1", "4", "999999999999999999999999"} {
		if _, err := ParseCoordinate(s, 3); err == nil {
			t.Errorf("accepted %q", s)
		}
	}
	for _, s := range []string{"0", "1", "3"} {
		if _, err := ParseCoordinate(s, 3); err != nil {
			t.Errorf("rejected %q", s)
		}
	}
}
