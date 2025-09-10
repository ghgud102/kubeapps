// Copyright 2021-2024 the Kubeapps contributors.
// SPDX-License-Identifier: Apache-2.0
import type { ServiceType } from "@bufbuild/protobuf";
import { createPromiseClient } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { Interceptor } from "@connectrpc/connect/dist/cjs/interceptor";
import { PromiseClient } from "@connectrpc/connect/dist/cjs/promise-client";
import { Transport } from "@connectrpc/connect/dist/cjs/transport";
import { PackagesService } from "gen/kubeappsapis/core/packages/v1alpha1/packages_connect";
import { RepositoriesService } from "gen/kubeappsapis/core/packages/v1alpha1/repositories_connect";
import { PluginsService } from "gen/kubeappsapis/core/plugins/v1alpha1/plugins_connect";
import {
  FluxV2PackagesService,
  FluxV2RepositoriesService,
} from "gen/kubeappsapis/plugins/fluxv2/packages/v1alpha1/fluxv2_connect";
import {
  HelmPackagesService,
  HelmRepositoriesService,
} from "gen/kubeappsapis/plugins/helm/packages/v1alpha1/helm_connect";
import {
  KappControllerPackagesService,
  KappControllerRepositoriesService,
} from "gen/kubeappsapis/plugins/kapp_controller/packages/v1alpha1/kapp_controller_connect";
import { ResourcesService } from "gen/kubeappsapis/plugins/resources/v1alpha1/resources_connect";

import { Auth } from "./Auth";
import * as URL from "./url";

function parseClusterAndNamespace(url: string): { cluster?: string; namespace?: string } {
  // URL의 해시(#) 이후 부분만 사용
  const hashPath = url.split('#')[1] ?? '';

  const clusterMatch = hashPath.match(/\/c\/([^/]+)/);
  const namespaceMatch = hashPath.match(/\/ns\/([^/]+)/);

  return {
    cluster: clusterMatch ? clusterMatch[1] : undefined,
    namespace: namespaceMatch ? namespaceMatch[1] : undefined,
  };
}

export class KubeappsGrpcClient {
  private transport: Transport;
  private saToken?: string; // 캐시용
  private saTokenPromise?: Promise<string>; // 동시에 여러 요청이 발생했을 때 처리
  
  // Creates a client with a transport, ensuring the transport includes the auth header.
  constructor(token?: string) {
    // CUD 오퍼레이팅 시 정상 동작을 위하여
    // 프론트엔드 KubeappsGrpcClient 의 인터셉터에서
    // Kubeapps 관리자 서비스어카운트에 해당하는 인증 헤더 주입
    const auth: Interceptor = next => async req => {


      // url에서 클러스터, 네임스페이스 데이터 추출
      const { cluster, namespace } = parseClusterAndNamespace(req.url);
      
      // deployment 리소스의 특정 경로에 새 configmap을 마운트하는 방식으로 아래 환경변수 사용 필요
      const kubeappsSaNamespace = "kubeapps"
      const kubeappsSaName = "kubeapps-admin"
      const openApiHostname = "10.120.105.31:31004"

      // 특정 클러스터의 'kubeapps-admin' SA 토큰 발급
      // saToken이 이미 있으면 그대로 사용
      if (!this.saToken) {
        // 여러 요청이 동시에 들어올 때 fetch가 중복되지 않도록 Promise 저장
        if (!this.saTokenPromise) {
          this.saTokenPromise = fetch(
            `http://${openApiHostname}/k8s/api/v1/clusters/${cluster}/namespaces/${kubeappsSaNamespace}/serviceaccounts/${kubeappsSaName}/token`,
            {
              headers: {
                Authorization: `Bearer ${token ?? Auth.getAuthToken()}`, // OIDC 로그인 토큰으로 인증
              },
            }
          )
            .then(res => {
              if (!res.ok) {
                throw new Error("Failed to fetch SA token");
              }
              return res.json();
            })
            .then(data => {
              // K8s tokenRequest 응답 형식은 { status: { token: "..." } }
              this.saToken = data.status?.token;
              return this.saToken!;
            })
            .finally(() => {
              this.saTokenPromise = undefined;
            });
        }
      }

      // 요청 URL 을 확인해서 생성 API일 경우 Authorization 헤더를 교체
      if (req.url.endsWith("PackagesService/CreateInstalledPackage")) {
        // const saToken = "eyJhbGciOiJSUzI1NiIsImtpZCI6ImplcktWSnRndDc3Y2l1VXUwSVk5SVBKMXBaMlRIdjRzanRkYTM5V3QxZTQifQ.eyJpc3MiOiJrdWJlcm5ldGVzL3NlcnZpY2VhY2NvdW50Iiwia3ViZXJuZXRlcy5pby9zZXJ2aWNlYWNjb3VudC9uYW1lc3BhY2UiOiJrdWJlYXBwcyIsImt1YmVybmV0ZXMuaW8vc2VydmljZWFjY291bnQvc2VjcmV0Lm5hbWUiOiJrdWJlYXBwcy1tb25pdG9yaW5nLWFkbWluLXRva2VuIiwia3ViZXJuZXRlcy5pby9zZXJ2aWNlYWNjb3VudC9zZXJ2aWNlLWFjY291bnQubmFtZSI6Imt1YmVhcHBzLW1vbml0b3JpbmctYWRtaW4iLCJrdWJlcm5ldGVzLmlvL3NlcnZpY2VhY2NvdW50L3NlcnZpY2UtYWNjb3VudC51aWQiOiI1ZWM5M2Y3OC03YWUyLTQyZDYtODgyYy04M2YwOGRkZjg2MTkiLCJzdWIiOiJzeXN0ZW06c2VydmljZWFjY291bnQ6a3ViZWFwcHM6a3ViZWFwcHMtbW9uaXRvcmluZy1hZG1pbiJ9.PUvnnivOb3NZhrLYP4BHbQqKL90LVWLnG7BMuEhj8ZqSk66YEcRH82G51O9BbwJhkUe-zs6vIEZkyApFyPdq5KvaYOJLL6fyb80FyxSMZkQ4JbVBYO7gjMEaA3sU-UkTJBDWJkd_JVB0b9gPrGUusNmuyH3o5iRMEE8LDpC7H7IXhmnfR0k3XgRORZNM35GYnSCVAEMxI0F6Ckqf2xqqAndDSBE7LPWs920otINryeYj-XFmMGhZnMtacgBnnzEfatpGC-Tc6XkMJrnfpLChBfMRmXVVhltoT2KGcO89TqxNcY2Qr79DEymugdG8S06cq9N3sR_OkIRqTvzGsvcD1w"; 
        req.header.set("Authorization", `Bearer ${this.saToken}`);
      } else {
        // 기본 동작: 기존의 로그인한 사용자의 OIDC 토큰 사용
        const t = token ? token : Auth.getAuthToken();
        if (t) {
          req.header.set("Authorization", `Bearer ${t}`);
        }
      }
      return await next(req);
    };
    this.transport = createGrpcWebTransport({
      baseUrl: `./${URL.api.kubeappsapis}`,
      interceptors: [auth],
    });
  }

  // getClientMetadata, if using token authentication, creates grpc metadata
  // and the token in the 'authorization' field
  public getClientMetadata(token?: string) {
    const t = token ? token : Auth.getAuthToken();
    return t ? new Headers({ Authorization: `Bearer ${t}` }) : undefined;
  }

  public getGrpcClient = <T extends ServiceType>(service: T): PromiseClient<T> => {
    return createPromiseClient(service, this.transport);
  };

  // Core APIs
  public getPackagesServiceClientImpl() {
    return this.getGrpcClient(PackagesService);
  }

  public getRepositoriesServiceClientImpl() {
    return this.getGrpcClient(RepositoriesService);
  }

  public getPluginsServiceClientImpl() {
    return this.getGrpcClient(PluginsService);
  }

  // Resources API
  //
  // The resources API client implementation takes an optional token
  // only because it is used to validate token authentication before
  // the token is stored.
  // TODO: investigate the token here.
  public getResourcesServiceClientImpl() {
    return this.getGrpcClient(ResourcesService);
  }

  // Plugins (packages/repositories) APIs
  // TODO(agamez): ideally, these clients should be loaded automatically from a list of configured plugins

  // Helm
  public getHelmPackagesServiceClientImpl() {
    return this.getGrpcClient(HelmPackagesService);
  }
  public getHelmRepositoriesServiceClientImpl() {
    return this.getGrpcClient(HelmRepositoriesService);
  }

  // KappController
  public getKappControllerPackagesServiceClientImpl() {
    return this.getGrpcClient(KappControllerPackagesService);
  }
  public getKappControllerRepositoriesServiceClientImpl() {
    return this.getGrpcClient(KappControllerRepositoriesService);
  }
  // Fluxv2
  public getFluxv2PackagesServiceClientImpl() {
    return this.getGrpcClient(FluxV2PackagesService);
  }
  public getFluxV2RepositoriesServiceClientImpl() {
    return this.getGrpcClient(FluxV2RepositoriesService);
  }
}

export default KubeappsGrpcClient;
